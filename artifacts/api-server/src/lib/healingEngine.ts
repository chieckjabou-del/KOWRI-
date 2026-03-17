// ── Healing Engine ────────────────────────────────────────────────────────────
//
// Secondary protective layer that runs AFTER the autopilot rules engine.
// Handles cases the rule-based system cannot: dynamic parameter tuning and
// component restarts.
//
// Safety contract (MANDATORY — do not relax):
//   • NEVER touch ledger_entries
//   • NEVER retry financial transactions automatically
//   • NEVER re-enable / auto-recover a kill switch — only the autopilot or
//     an operator may do that
//   • ONLY reduce load or restart safe, idempotent components
//
// Cooldown: each action has its own 30-second cooldown to prevent thrashing.
//
// ROLLBACK: remove `await autoHeal(metrics)` from autopilot.ts; delete this file.

import { CollectedMetrics }              from "./metricsCollector";
import { insertIncident }                from "./incidentStore";
import { getSwitch }                     from "./killSwitch";
import { forcePrimaryReads, pauseOutboxWorker } from "./actionExecutor";
import { getBatchSize, setBatchSize, stopOutboxWorker, startOutboxWorker } from "./outboxWorker";

// ── Cooldown registry ─────────────────────────────────────────────────────────

const COOLDOWN_MS = 30_000;   // 30 s between identical healing actions
const cooldowns   = new Map<string, number>();

function isCooling(actionId: string): boolean {
  const last = cooldowns.get(actionId) ?? 0;
  return Date.now() - last < COOLDOWN_MS;
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

// ── Stuck-pending detector ────────────────────────────────────────────────────
// Two consecutive cycles with outbox_pending > STUCK_THRESHOLD and no decrease
// indicates the worker is not making progress.

const STUCK_PENDING_THRESHOLD = 500;
let   lastPendingCount        = -1;   // -1 = first cycle, no baseline yet

function isOutboxStuck(current: number): boolean {
  if (current <= STUCK_PENDING_THRESHOLD) return false;
  if (lastPendingCount < 0)              return false;  // no baseline
  return current >= lastPendingCount;                   // flat or growing
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const DB_LATENCY_HIGH_MS = Number(process.env.HEAL_DB_LATENCY_MS    ?? 800);
const DLQ_THRESHOLD      = Number(process.env.AUTOPILOT_DLQ_THRESHOLD ?? 5);
const LAG_THRESHOLD_S    = Number(process.env.AUTOPILOT_LAG_THRESHOLD_S ?? 5);

// ── Main heal function ────────────────────────────────────────────────────────

export async function autoHeal(metrics: CollectedMetrics): Promise<void> {

  // ── Case A: DB_LATENCY_HIGH ───────────────────────────────────────────────
  // Reduce outbox batch size by 50% to lower DB write pressure.
  // Does NOT stop events — just throttles throughput.
  // Batch size resets on process restart; no automatic re-expansion.
  if (metrics.db_latency > DB_LATENCY_HIGH_MS && !isCooling("reduce_batch")) {
    const before  = getBatchSize();
    const after   = Math.max(5, Math.floor(before * 0.5));
    setBatchSize(after);
    arm("reduce_batch");

    const result = `batchSize ${before}→${after} db_latency=${metrics.db_latency}ms`;
    console.warn(`[HealingEngine] reduce_batch: ${result}`);
    await insertIncident({ type: "auto_heal", action: "reduce_batch", result });
  }

  // ── Case B: OUTBOX_STUCK ──────────────────────────────────────────────────
  // Restart the outbox worker when pending count is high and not draining.
  // Safe because processOne() is idempotent via the processed_events fence —
  // any event that already committed is silently skipped on re-processing.
  // recoverStuckProcessing() runs at startup and resets "processing" → "pending"
  // so in-flight rows from the killed interval are retried.
  if (isOutboxStuck(metrics.outbox_pending) && !isCooling("restart_worker")) {
    stopOutboxWorker();
    startOutboxWorker();       // triggers recoverStuckProcessing() internally
    arm("restart_worker");

    const result = `pending=${metrics.outbox_pending} (prev=${lastPendingCount}) — worker restarted`;
    console.warn(`[HealingEngine] restart_worker: ${result}`);
    await insertIncident({ type: "auto_heal", action: "restart_worker", result });
  }

  // Update stuck-detection baseline AFTER the restart check (post-action baseline).
  lastPendingCount = metrics.outbox_pending;

  // ── Case C: REPLICA_LAG_HIGH ──────────────────────────────────────────────
  // Belt-and-suspenders: autopilot handles this via the replica_lag rule, but
  // the healing engine fires independently if the switch is still ENABLED.
  // No auto-recovery here — the autopilot rule handles that.
  if (metrics.replica_lag > LAG_THRESHOLD_S && !isCooling("force_primary")) {
    const sw = getSwitch("replica_reads");
    if (sw.state === "ENABLED") {
      forcePrimaryReads({
        triggeredBy: "heal",
        reason:      `replica_lag=${metrics.replica_lag.toFixed(1)}s > ${LAG_THRESHOLD_S}s`,
      });
      arm("force_primary");

      const result = `replica_lag=${metrics.replica_lag.toFixed(1)}s`;
      console.warn(`[HealingEngine] force_primary: ${result}`);
      await insertIncident({ type: "auto_heal", action: "force_primary", result });
    }
  }

  // ── Case D: DLQ_SPIKE ────────────────────────────────────────────────────
  // Belt-and-suspenders: autopilot handles this via the dlq_rate rule.
  // Healing engine fires if the switch is still ENABLED.
  // No auto-recovery — the outbox must be manually inspected before resuming.
  if (metrics.dlq_rate >= DLQ_THRESHOLD && !isCooling("pause_outbox")) {
    const sw = getSwitch("outbox_dispatch");
    if (sw.state === "ENABLED") {
      pauseOutboxWorker({
        triggeredBy: "heal",
        reason:      `dlq_rate=${metrics.dlq_rate} >= threshold=${DLQ_THRESHOLD}`,
      });
      arm("pause_outbox");

      const result = `dlq_rate=${metrics.dlq_rate} threshold=${DLQ_THRESHOLD}`;
      console.warn(`[HealingEngine] pause_outbox: ${result}`);
      await insertIncident({ type: "auto_heal", action: "pause_outbox", result });
    }
  }
}
