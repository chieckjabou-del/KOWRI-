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
import { globalEvaluator }                                       from "./globalEvaluator";
import { strategyEngine, getStrategyMode }                       from "./strategyEngine";
import { learningEngine }                                        from "./learningEngine";
import { selfOptimize }                                          from "./selfOptimizer";
import { optimizeFees }                                          from "./feeOptimizer";
import { runLiquidityMonitor }                                  from "./liquidityEngine";
import { resetBatchLock }                                        from "./batchController";
import { writeAutopilotState }                                   from "./autopilotStateStore";
import { db }                                                    from "@workspace/db";
import { sql }                                                   from "drizzle-orm";

const POLL_MS = 5_000;

// Advisory lock constant — uniquely identifies the autopilot process in pg_try_advisory_lock.
// Using a distributed DB lock instead of an in-memory flag makes the guard safe
// across multiple autoscale instances (each process has cycleRunning=false on start).
const ADVISORY_LOCK_ID = 42424242;

// ── Sentinel state ────────────────────────────────────────────────────────────
// Tracks the previous cycle's readings so frozen/zero values are caught before
// they silently corrupt all 9 downstream layers.
let _sentinelPrev:     { db_latency: number; outbox_pending: number; dlq_rate: number } | null = null;
let _sentinelRepeated: number = 0;
const SENTINEL_MAX_REPEATED = 3;

// ── Cycle health signals — exposed by getAutopilotHealth() for /live ──────────
// Updated each cycle so the War Room can compute trust score without DB queries.
let _metricsHealthy:   boolean = true;
let _dbWriteable:      boolean = true;
let _lastCycleEndTime: number  = 0;

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
  const lockResult = await db.execute(
    sql`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_ID}) AS acquired`,
  );
  const rows = (lockResult as { rows?: Array<{ acquired?: boolean }> }).rows;
  const acquired =
    rows?.[0]?.acquired ??
    (Array.isArray(lockResult) ? (lockResult[0] as { acquired?: boolean } | undefined)?.acquired : undefined) ??
    false;
  if (!acquired) return;

  try {
    // Reset the per-cycle batch-change lock so all layers start with a clean slate.
    // Must be the first operation — before any layer that could call requestBatchChange.
    resetBatchLock();

    // Step 1 — collect metrics.  On failure, log and abort this cycle.
    let metrics;
    try {
      metrics = await collectMetrics();
    } catch (err) {
      console.error("[Autopilot] metrics collection failed — skipping cycle:", err);
      return;
    }

    // Step 1b — sentinel: reject metrics that are non-finite, have zero db_latency,
    // or are identical to the previous cycle for SENTINEL_MAX_REPEATED consecutive
    // cycles (indicates a frozen/cached query result).
    const isNonFinite =
      !isFinite(metrics.db_latency)     ||
      !isFinite(metrics.outbox_pending) ||
      !isFinite(metrics.dlq_rate);

    if (isNonFinite || metrics.db_latency === 0) {
      const result =
        `db_latency=${metrics.db_latency} outbox_pending=${metrics.outbox_pending} dlq_rate=${metrics.dlq_rate}`;
      console.error("[Autopilot] sentinel: non-finite/zero metrics — skipping cycle:", result);
      logIncident({ type: "metrics_collector", action: "sentinel_rejected", result });
      _metricsHealthy   = false;
      _sentinelPrev     = null;
      _sentinelRepeated = 0;
      return;
    }

    const isRepeated =
      _sentinelPrev !== null &&
      metrics.db_latency     === _sentinelPrev.db_latency &&
      metrics.outbox_pending === _sentinelPrev.outbox_pending &&
      metrics.dlq_rate       === _sentinelPrev.dlq_rate;

    _sentinelPrev = {
      db_latency:     metrics.db_latency,
      outbox_pending: metrics.outbox_pending,
      dlq_rate:       metrics.dlq_rate,
    };

    if (isRepeated) {
      _sentinelRepeated++;
      if (_sentinelRepeated >= SENTINEL_MAX_REPEATED) {
        const result =
          `db_latency=${metrics.db_latency} repeated=${_sentinelRepeated}_consecutive_cycles`;
        console.error("[Autopilot] sentinel: metrics frozen —", result, "— skipping cycle");
        logIncident({ type: "metrics_collector", action: "sentinel_repeated", result });
        _metricsHealthy   = false;
        _sentinelRepeated = 0;
        return;
      }
    } else {
      _sentinelRepeated = 0;
    }

    // Sentinel checks passed — metrics are valid for this cycle.
    _metricsHealthy = true;
    _dbWriteable    = true; // reset; catch below sets it false if persist fails

    // Step 2 — persist metrics snapshot (fire-and-forget; never blocks the cycle).
    insertMetrics([
      { key: "balance_drift",  value: metrics.balance_drift  },
      { key: "replica_lag",    value: metrics.replica_lag    },
      { key: "db_latency",     value: metrics.db_latency     },
      { key: "outbox_pending", value: metrics.outbox_pending },
      { key: "dlq_rate",       value: metrics.dlq_rate       },
    ]).catch((err) => {
      const errMsg = String((err as any)?.message ?? err);
      console.error("[Autopilot] metric persist failed:", err);
      logIncident({ type: "metrics_store", action: "write_failed", result: errMsg });
      _dbWriteable = false;
    });

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

    // Step 6 — audit whether the active strategy mode is producing improvement.
    // Runs BEFORE strategyEngine so that any suppression flags are visible when
    // the mode is computed for this cycle.  Isolated — errors must never abort.
    try {
      await globalEvaluator(metrics);
    } catch (err) {
      console.error("[Autopilot] globalEvaluator error:", err);
    }

    // Step 7 — determine strategic mode (LATENCY_FIRST / THROUGHPUT_FIRST / BALANCED).
    // Respects any suppressions set by globalEvaluator this cycle.
    try {
      await strategyEngine(metrics);
    } catch (err) {
      console.error("[Autopilot] strategyEngine error:", err);
    }

    // Step 8 — run learning engine; uses current strategy mode to scale pre-adjustments.
    try {
      await learningEngine(metrics);
    } catch (err) {
      console.error("[Autopilot] learningEngine error:", err);
    }

    // Step 9 — run self-optimizer last; uses current strategy mode for step sizing.
    try {
      await selfOptimize(metrics);
    } catch (err) {
      console.error("[Autopilot] selfOptimizer error:", err);
    }

    // Step 10 — fee optimizer: adjust cashout rate based on live metrics and strategy.
    // Completely isolated — a failure here never affects any other autopilot layer.
    try {
      await optimizeFees(metrics, getStrategyMode());
    } catch (err) {
      logIncident({
        type:   "fee_optimizer",
        action: "cycle_error",
        result: (err as any)?.message ?? "unknown",
      });
      console.error("[Autopilot] feeOptimizer error:", err);
    }

    // Step 11 — liquidity monitor: check all active agents for cash/float thresholds
    // and detect zone tension.  Completely isolated — never affects any other layer.
    try {
      await runLiquidityMonitor();
    } catch (err) {
      logIncident({
        type:   "liquidity_monitor",
        action: "cycle_error",
        result: (err as any)?.message ?? "unknown",
      });
      console.error("[Autopilot] liquidityMonitor error:", err);
    }

    // Persist state snapshot (fire-and-forget — never blocks the cycle).
    writeAutopilotState();
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_ID})`);
    _lastCycleEndTime = Date.now();
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

export function getAutopilotHealth(): {
  metricsHealthy:   boolean;
  dbWriteable:      boolean;
  lastCycleEndTime: number;
} {
  return {
    metricsHealthy:   _metricsHealthy,
    dbWriteable:      _dbWriteable,
    lastCycleEndTime: _lastCycleEndTime,
  };
}
