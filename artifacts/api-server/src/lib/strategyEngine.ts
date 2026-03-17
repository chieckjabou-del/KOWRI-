// ── Strategy Engine ───────────────────────────────────────────────────────────
//
// Determines the system's current optimization mode every autopilot cycle and
// makes that mode available to all downstream layers via getStrategyMode().
//
// Modes
//   THROUGHPUT_FIRST  — queue is backing up; maximize event processing rate
//   LATENCY_FIRST     — DB is stressed; minimize write pressure
//   BALANCED          — all metrics nominal; default steady-state
//
// Anti-oscillation
//   The current mode must persist for at least MIN_MODE_DWELL cycles before a
//   switch is allowed.  This prevents thrashing when metrics sit near a boundary.
//   Once a switch fires the dwell counter resets to 0 (incremented to 1 at the
//   end of that cycle), so the new mode is immediately protected for 3 cycles.
//
// Integration contract
//   • Runs as Step 6 in the autopilot cycle — after autoHeal, before learningEngine
//   • Consumers call getStrategyMode() synchronously; no import cycles
//   • autoHeal is NEVER aware of or affected by the current mode
//
// ROLLBACK: remove the step-6 block from autopilot.ts; delete this file.

import { CollectedMetrics } from "./metricsCollector";
import { insertIncident }   from "./incidentStore";

// ── Types ─────────────────────────────────────────────────────────────────────

export type StrategyMode = "LATENCY_FIRST" | "THROUGHPUT_FIRST" | "BALANCED";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Cycles the current mode must have been active before a switch is allowed. */
const MIN_MODE_DWELL = 3;

/** Latency (ms) that tips the mode toward LATENCY_FIRST.
 *  Set between learningEngine's HIGH (200 ms) and autoHeal's emergency (800 ms). */
const LATENCY_HIGH_MS = Number(process.env.STRATEGY_LATENCY_HIGH_MS ?? 400);

/** Pending event count that tips the mode toward THROUGHPUT_FIRST.
 *  Set below healingEngine's stuck threshold (500) so we react earlier. */
const PENDING_HIGH = Number(process.env.STRATEGY_PENDING_HIGH ?? 300);

// ── State ─────────────────────────────────────────────────────────────────────

let currentMode:  StrategyMode = "BALANCED";
let cyclesInMode: number       = 0;

// ── Mode computation ──────────────────────────────────────────────────────────

function computeDesiredMode(metrics: CollectedMetrics): StrategyMode {
  // THROUGHPUT_FIRST takes precedence over LATENCY_FIRST so that a queue backup
  // is never inadvertently made worse by latency-driven batch reductions.
  if (metrics.outbox_pending > PENDING_HIGH) return "THROUGHPUT_FIRST";
  if (metrics.db_latency     > LATENCY_HIGH_MS) return "LATENCY_FIRST";
  return "BALANCED";
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns the current strategy mode.  Safe to call from any downstream module. */
export function getStrategyMode(): StrategyMode {
  return currentMode;
}

export function getStrategyState() {
  return {
    currentMode,
    cyclesInMode,
    dwellRequired: MIN_MODE_DWELL,
    canSwitchIn:   Math.max(0, MIN_MODE_DWELL - cyclesInMode),
    thresholds: {
      latencyHighMs: LATENCY_HIGH_MS,
      pendingHigh:   PENDING_HIGH,
    },
  };
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function strategyEngine(metrics: CollectedMetrics): Promise<void> {
  const desiredMode = computeDesiredMode(metrics);

  if (desiredMode !== currentMode && cyclesInMode >= MIN_MODE_DWELL) {
    // ── Switch allowed — dwell requirement satisfied ──────────────────────────
    const previous = currentMode;
    currentMode    = desiredMode;
    cyclesInMode   = 0;   // reset before increment below → will be 1 at end of cycle

    const reason =
      desiredMode === "THROUGHPUT_FIRST"
        ? `pending=${metrics.outbox_pending}>threshold=${PENDING_HIGH}`
        : desiredMode === "LATENCY_FIRST"
        ? `latency=${metrics.db_latency}ms>threshold=${LATENCY_HIGH_MS}ms`
        : `all_metrics_normal`;

    const result =
      `mode=${desiredMode} previous=${previous} reason=${reason} ` +
      `latency=${metrics.db_latency}ms pending=${metrics.outbox_pending}`;

    console.info(`[StrategyEngine] mode_switch: ${result}`);
    await insertIncident({ type: "strategy_engine", action: "mode_switch", result });
  }
  // Always increment regardless of whether a switch happened.
  // After a switch: cyclesInMode 0 → 1.
  // Stable: cyclesInMode N → N+1.
  cyclesInMode++;
}
