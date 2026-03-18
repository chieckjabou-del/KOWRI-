// ── Healing Engine ────────────────────────────────────────────────────────────
//
// Secondary protective layer that runs AFTER the autopilot rules engine.
// Handles cases the rule-based system cannot: dynamic parameter tuning and
// component restarts.
//
// Safety contract (MANDATORY — do not relax):
//   • NEVER touch ledger_entries
//   • NEVER retry financial transactions automatically
//   • NEVER re-enable / auto-recover a kill switch
//   • ONLY reduce load, restore safe throughput params, or restart idempotent components
//
// Cooldown: each action key has its own 30-second cooldown enforced before any
// logic executes — isCooling() is always the first check in every branch.
//
// ROLLBACK: remove `await autoHeal(metrics)` from autopilot.ts; delete this file.

import { CollectedMetrics }                    from "./metricsCollector";
import { logIncident }                          from "./incidentStore";
import { getSwitch }                            from "./killSwitch";
import { forcePrimaryReads, pauseOutboxWorker } from "./actionExecutor";
import {
  getBatchSize,
  stopOutboxWorker,
  startOutboxWorker,
  isWorkerRunning,
  DEFAULT_BATCH_SIZE,
}                                               from "./outboxWorker";
import { requestBatchChange }                   from "./batchController";

// ── Thresholds (env-overridable) ──────────────────────────────────────────────

const DB_LATENCY_HIGH_MS  = Number(process.env.HEAL_DB_LATENCY_MS        ?? 800);
const DB_LATENCY_OK_MS    = Number(process.env.HEAL_DB_LATENCY_OK_MS     ?? 300);
const DLQ_THRESHOLD       = Number(process.env.AUTOPILOT_DLQ_THRESHOLD   ?? 5);
const LAG_THRESHOLD_S     = Number(process.env.AUTOPILOT_LAG_THRESHOLD_S ?? 5);
const STUCK_THRESHOLD     = Number(process.env.HEAL_STUCK_THRESHOLD      ?? 500);
const BATCH_RECOVER_STEP  = 5;    // units to re-add per recovery tick
const BATCH_RECOVER_CYCLES = 3;   // consecutive ok cycles required before recovery

// ── Cooldown registry ─────────────────────────────────────────────────────────
// isCooling() is the FIRST check in every branch. No logic runs while cooling.

const COOLDOWN_MS = 30_000;
const cooldowns   = new Map<string, number>();

function isCooling(actionId: string): boolean {
  return Date.now() - (cooldowns.get(actionId) ?? 0) < COOLDOWN_MS;
}

function arm(actionId: string): void {
  cooldowns.set(actionId, Date.now());
}

export function getCooldownState(): Record<string, { coolsDownAt: number; remainingMs: number }> {
  const now = Date.now();
  const out: Record<string, { coolsDownAt: number; remainingMs: number }> = {};
  for (const [id, firedAt] of cooldowns.entries()) {
    const remaining = COOLDOWN_MS - (now - firedAt);
    if (remaining > 0) out[id] = { coolsDownAt: firedAt + COOLDOWN_MS, remainingMs: remaining };
  }
  return out;
}

// ── Batch-size recovery state ─────────────────────────────────────────────────
// Counts consecutive cycles where db_latency < DB_LATENCY_OK_MS.
// Resets to 0 on any high-latency cycle so recovery only happens after a
// sustained healthy window — not after a single lucky probe.

let consecutiveOkCycles = 0;

// ── Stuck-pending detector (2-cycle window) ───────────────────────────────────
// pendingHistory holds the pending counts from [cycle-2, cycle-1].
// Stuck = current > STUCK_THRESHOLD AND all three values (history[0], history[1],
// current) are above threshold AND current >= history[0] (no net decrease over
// two full cycles).  Two readings required to avoid false positives on transient
// spikes that clear in the next cycle.

const pendingHistory: [number, number] = [-1, -1];   // [-1] = not yet observed

function isOutboxStuck(current: number): boolean {
  const [prev2, prev1] = pendingHistory;
  if (current <= STUCK_THRESHOLD)  return false;   // below threshold — fine
  if (prev2 < 0 || prev1 < 0)     return false;   // need 2 full cycles of data
  if (prev1 <= STUCK_THRESHOLD)   return false;   // previous cycle was clear
  return current >= prev2;                         // no net decrease across 2 cycles
}

function advancePendingHistory(current: number): void {
  pendingHistory[0] = pendingHistory[1];
  pendingHistory[1] = current;
}

// ── Main heal function ────────────────────────────────────────────────────────

export async function autoHeal(metrics: CollectedMetrics): Promise<void> {

  // ── Case A: DB_LATENCY_HIGH — reduce batch size ───────────────────────────
  // Throttle outbox throughput to shed DB write pressure.
  // Does NOT pause events — just reduces the batch window.
  if (metrics.db_latency > DB_LATENCY_HIGH_MS && !isCooling("reduce_batch")) {
    const before = getBatchSize();
    const after  = Math.max(5, Math.floor(before * 0.5));
    requestBatchChange("healingEngine:reduce_batch", after);
    arm("reduce_batch");
    consecutiveOkCycles = 0;   // reset recovery counter on any high-latency cycle

    const result = `batchSize=${before}→${after} db_latency=${metrics.db_latency}ms`;
    console.warn(`[HealingEngine] reduce_batch: ${result}`);
    logIncident({ type: "auto_heal", action: "reduce_batch", result });
  }

  // ── Case A recovery: DB_LATENCY_OK — restore batch size gradually ─────────
  // Increase batch size by BATCH_RECOVER_STEP after BATCH_RECOVER_CYCLES
  // consecutive cycles under DB_LATENCY_OK_MS.  Clamps to DEFAULT_BATCH_SIZE.
  // This is NOT a kill switch re-enable — it restores a throughput parameter only.
  else if (metrics.db_latency < DB_LATENCY_OK_MS) {
    consecutiveOkCycles++;

    if (consecutiveOkCycles >= BATCH_RECOVER_CYCLES && !isCooling("increase_batch")) {
      const before = getBatchSize();
      if (before < DEFAULT_BATCH_SIZE) {
        const after = Math.min(DEFAULT_BATCH_SIZE, before + BATCH_RECOVER_STEP);
        requestBatchChange("healingEngine:increase_batch", after);
        arm("increase_batch");
        consecutiveOkCycles = 0;   // reset so next recovery waits another 3 cycles

        const result = `batchSize=${before}→${after} db_latency=${metrics.db_latency}ms consecutiveOk=${BATCH_RECOVER_CYCLES}`;
        console.info(`[HealingEngine] increase_batch: ${result}`);
        logIncident({ type: "auto_heal", action: "increase_batch", result });
      }
    }
  } else {
    // Latency is between OK and HIGH — neither reduce nor recover, but reset
    // the consecutive counter so we don't restore too eagerly.
    consecutiveOkCycles = 0;
  }

  // ── Case B: OUTBOX_STUCK — safe worker restart ────────────────────────────
  // Restart only when stuck across TWO consecutive cycles to avoid false positives.
  // Safe: processOne() is idempotent via the processed_events fence.
  // Safe restart protocol: check running state before stopping, then start.
  if (isOutboxStuck(metrics.outbox_pending) && !isCooling("safe_restart_worker")) {
    const [prev2] = pendingHistory;

    if (isWorkerRunning()) {
      stopOutboxWorker();
    }
    startOutboxWorker();   // no-op if somehow still running; triggers recoverStuckProcessing()
    arm("safe_restart_worker");

    const result = `pending=${metrics.outbox_pending} prev2=${prev2} — safe_restart_worker`;
    console.warn(`[HealingEngine] safe_restart_worker: ${result}`);
    logIncident({ type: "auto_heal", action: "safe_restart_worker", result });
  }

  // Advance the 2-cycle history AFTER the stuck check so the check uses the
  // values from before this cycle's restart (accurate baseline).
  advancePendingHistory(metrics.outbox_pending);

  // ── Case C: REPLICA_LAG_HIGH — force primary reads ────────────────────────
  // Belt-and-suspenders: autopilot's replica_lag rule fires first.
  // Healing engine fires only if switch is still ENABLED (idempotent guard).
  // No recovery here — autopilot handles that when lag drops.
  if (metrics.replica_lag > LAG_THRESHOLD_S && !isCooling("force_primary")) {
    const sw = getSwitch("replica_reads");
    if (sw.state === "ENABLED") {
      forcePrimaryReads({
        triggeredBy: "heal",
        reason:      `replica_lag=${metrics.replica_lag.toFixed(1)}s > ${LAG_THRESHOLD_S}s`,
      });
      arm("force_primary");

      const result = `replica_lag=${metrics.replica_lag.toFixed(1)}s threshold=${LAG_THRESHOLD_S}s`;
      console.warn(`[HealingEngine] force_primary: ${result}`);
      logIncident({ type: "auto_heal", action: "force_primary", result });
    }
    // If sw.state !== "ENABLED": already paused by autopilot or operator — do nothing.
  }

  // ── Case D: DLQ_SPIKE — pause outbox dispatch ─────────────────────────────
  // Belt-and-suspenders: autopilot's dlq_rate rule fires first.
  // Guard: if outbox already paused (switch TRIGGERED or FORCED_OFF), skip entirely —
  // avoids duplicate incidents and prevents double-fire on the kill switch.
  if (metrics.dlq_rate >= DLQ_THRESHOLD && !isCooling("pause_outbox")) {
    const sw = getSwitch("outbox_dispatch");
    if (sw.state === "ENABLED") {   // explicitly: do nothing if already paused
      pauseOutboxWorker({
        triggeredBy: "heal",
        reason:      `dlq_rate=${metrics.dlq_rate} >= threshold=${DLQ_THRESHOLD}`,
      });
      arm("pause_outbox");

      const result = `dlq_rate=${metrics.dlq_rate} threshold=${DLQ_THRESHOLD}`;
      console.warn(`[HealingEngine] pause_outbox: ${result}`);
      logIncident({ type: "auto_heal", action: "pause_outbox", result });
    }
    // sw.state !== "ENABLED": already paused — do nothing, no incident logged.
  }
}
