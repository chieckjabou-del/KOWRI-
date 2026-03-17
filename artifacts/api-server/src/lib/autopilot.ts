// ── Autopilot ─────────────────────────────────────────────────────────────────
//
// Self-driving control loop.  Every POLL_MS milliseconds it:
//   1. Collects the five system metrics
//   2. Persists them to the metrics table (fire-and-forget)
//   3. Evaluates all rules against the snapshot
//   4. Takes the appropriate action for each triggered / recovered rule
//   5. Logs every action to the incidents table
//
// Safety contract:
//   • FORCED_OFF switches are NEVER touched — operator intent is respected.
//   • Only TRIGGERED switches are eligible for auto-recovery.
//   • A single rule failure never stops the loop — errors are caught per-rule.
//   • An unrecoverable metrics collection error aborts the cycle and logs it;
//     the next cycle starts fresh.
//
// ROLLBACK: remove startAutopilot() call from index.ts; delete this file.

import { collectMetrics }                                         from "./metricsCollector";
import { evaluateRules, RULES, AutopilotAction, RuleEvaluation } from "./rulesEngine";
import { insertMetrics }                                          from "./metricsStore";
import { logIncident }                                            from "./incidentStore";
import { getSwitch, KillSwitchName }                             from "./killSwitch";
import {
  disableTransfers,
  enableTransfers,
  pauseOutboxWorker,
  resumeOutboxWorker,
  forcePrimaryReads,
  restoreReplicaReads,
}                                                                 from "./actionExecutor";
import { autoHeal }                                               from "./healingEngine";

const POLL_MS = 5_000;

// ── Action dispatch table ─────────────────────────────────────────────────────
// Maps each AutopilotAction to the existing executor functions + the switch
// name that guards it.  Keeps the cycle loop free of if/else chains.

interface ActionHandler {
  switchName: KillSwitchName;
  fire:       (reason: string) => void;
  recover:    () => void;
}

const ACTION_HANDLERS: Record<AutopilotAction, ActionHandler> = {
  STOP_TRANSFERS: {
    switchName: "outbound_transfers",
    fire:       (reason) => { disableTransfers({ triggeredBy: "autopilot", reason }); },
    recover:    ()       => { enableTransfers("autopilot"); },
  },
  FORCE_PRIMARY: {
    switchName: "replica_reads",
    fire:       (reason) => { forcePrimaryReads({ triggeredBy: "autopilot", reason }); },
    recover:    ()       => { restoreReplicaReads("autopilot"); },
  },
  PAUSE_OUTBOX: {
    switchName: "outbox_dispatch",
    fire:       (reason) => { pauseOutboxWorker({ triggeredBy: "autopilot", reason }); },
    recover:    ()       => { resumeOutboxWorker("autopilot"); },
  },
};

// ── Per-rule action executor ──────────────────────────────────────────────────

function applyEvaluation(ev: RuleEvaluation): void {
  const handler = ACTION_HANDLERS[ev.action];
  const sw      = getSwitch(handler.switchName);

  if (ev.triggered) {
    // ── Fire path ────────────────────────────────────────────────────────────
    if (sw.state === "FORCED_OFF") {
      // Operator has hard-locked this switch — autopilot must not override.
      return;
    }
    if (sw.state === "TRIGGERED") {
      // Already fired in a previous cycle — no duplicate action needed.
      return;
    }

    // ENABLED → fire the action.
    try {
      handler.fire(ev.reason);
      console.warn(
        `[Autopilot] FIRE   rule=${ev.ruleId} metric=${ev.metric}` +
        `=${ev.value} action=${ev.action} reason="${ev.reason}"`,
      );
      logIncident({ type: ev.ruleId, action: ev.action, result: "fired" });
    } catch (err) {
      const errMsg = String((err as any)?.message ?? err);
      console.error(`[Autopilot] action failed rule=${ev.ruleId}:`, err);
      logIncident({ type: ev.ruleId, action: ev.action, result: `error:${errMsg}` });
    }

  } else if (ev.recovered) {
    // ── Recover path ──────────────────────────────────────────────────────────
    if (sw.state !== "TRIGGERED") {
      // Only auto-recover autopilot-fired switches.
      // ENABLED   → nothing to do.
      // FORCED_OFF → operator locked it; manual lift only.
      return;
    }

    try {
      handler.recover();
      console.info(
        `[Autopilot] RECOVER rule=${ev.ruleId} metric=${ev.metric}=${ev.value}`,
      );
      logIncident({
        type:   ev.ruleId,
        action: `recover:${ev.action}`,
        result: "recovered",
      });
    } catch (err) {
      const errMsg = String((err as any)?.message ?? err);
      console.error(`[Autopilot] recovery failed rule=${ev.ruleId}:`, err);
      logIncident({
        type:   ev.ruleId,
        action: `recover:${ev.action}`,
        result: `error:${errMsg}`,
      });
    }
  }
}

// ── Main cycle ────────────────────────────────────────────────────────────────

export async function runAutopilotCycle(): Promise<void> {
  // Step 1 — collect metrics.  On failure, log and abort this cycle.
  let metrics;
  try {
    metrics = await collectMetrics();
  } catch (err) {
    console.error("[Autopilot] metrics collection failed — skipping cycle:", err);
    return;
  }

  // Step 2 — persist metrics snapshot (fire-and-forget; never blocks the cycle).
  insertMetrics([
    { key: "balance_drift",  value: metrics.balance_drift  },
    { key: "replica_lag",    value: metrics.replica_lag    },
    { key: "db_latency",     value: metrics.db_latency     },
    { key: "outbox_pending", value: metrics.outbox_pending },
    { key: "dlq_rate",       value: metrics.dlq_rate       },
  ]).catch((err) => console.error("[Autopilot] metric persist failed:", err));

  // Step 3 — evaluate all rules against the snapshot.
  const evaluations = evaluateRules(metrics);

  // Step 4 — apply autopilot rules.  Each rule is isolated; one failure doesn't stop others.
  for (const ev of evaluations) {
    try {
      applyEvaluation(ev);
    } catch (err) {
      console.error(`[Autopilot] unexpected error processing rule=${ev.ruleId}:`, err);
    }
  }

  // Step 5 — run healing engine AFTER rules so protective switches are already
  // in place before healing actions are evaluated.  Any error is isolated —
  // it must never propagate to the caller.
  try {
    await autoHeal(metrics);
  } catch (err) {
    console.error("[Autopilot] healingEngine error:", err);
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let autopilotInterval: ReturnType<typeof setInterval> | null = null;

export function startAutopilot(): void {
  if (autopilotInterval) return;

  autopilotInterval = setInterval(() => {
    runAutopilotCycle().catch((err) =>
      console.error("[Autopilot] unhandled cycle error:", err),
    );
  }, POLL_MS);

  // unref() so the event loop can exit cleanly in tests / graceful shutdown.
  autopilotInterval.unref();

  console.info(`[Autopilot] started — poll every ${POLL_MS / 1_000}s | rules: ${RULES.map(r => r.id).join(", ")}`);
}

export function stopAutopilot(): void {
  if (!autopilotInterval) return;
  clearInterval(autopilotInterval);
  autopilotInterval = null;
  console.info("[Autopilot] stopped");
}

// ── Observability ─────────────────────────────────────────────────────────────

export function getAutopilotState() {
  return {
    running: autopilotInterval !== null,
    pollMs:  POLL_MS,
    rules:   RULES.map(r => ({
      id:     r.id,
      metric: r.metric,
      action: r.action,
    })),
  };
}
