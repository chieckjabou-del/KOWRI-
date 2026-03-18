// ── Self-Optimizing Layer ─────────────────────────────────────────────────────
//
// Additive layer that runs AFTER autoHeal() each cycle.  It does NOT replace
// static safeguards — it adds proactive trend-driven tuning BEFORE static
// thresholds are breached.
//
// Responsibilities:
//   • Maintain 12-cycle rolling windows for db_latency, outbox_pending, dlq_rate
//   • Compute adaptive thresholds (falls back to static when window not full)
//   • Detect 3-point trends (rising / falling / stable)
//   • Track effectiveness of the last 5 batch-control decisions
//   • Make AT MOST 1 batch-size decision per cycle (early return after first)
//   • Log every decision as action="self_optimize"
//
// Safety contract:
//   • NEVER re-enables or modifies any kill switch
//   • NEVER exceeds DEFAULT_BATCH_SIZE
//   • NEVER goes below MIN_BATCH_SIZE (5)
//   • Does not fire inside autoHeal's emergency zone (< HIGH threshold boundary)
//
// ROLLBACK: remove `await selfOptimize(metrics)` from autopilot.ts; delete this file.

import { CollectedMetrics }                               from "./metricsCollector";
import { getBatchSize, DEFAULT_BATCH_SIZE }               from "./outboxWorker";
import { requestBatchChange }                             from "./batchController";
import { logIncident }                                     from "./incidentStore";
import { getStrategyMode }                                 from "./strategyEngine";

// ── Constants ─────────────────────────────────────────────────────────────────

const WINDOW_SIZE    = 12;          // rolling window length (cycles)
const TREND_SIZE     = 3;           // values needed for trend detection
const MEM_SIZE       = 5;           // max action effectiveness records
const MIN_BATCH_SIZE = 5;           // mirror of outboxWorker constant

// Normal self-optimize step sizes (conservative — autoHeal handles emergencies)
const REDUCE_FACTOR   = 0.10;       // 10% of current batch size per reduce nudge
const REDUCE_STEP_MIN = 1;          // minimum nudge when action is ineffective
const INCREASE_STEP   = 1;          // single-unit increase per recovery nudge

// Decision A1 — evaluate-after-N-cycles window
const A1_EVAL_CYCLES  = 3;          // cycles to wait before re-evaluating A1 effectiveness

// Static threshold fallbacks (loaded from env; mirror autoHeal / rulesEngine)
const STATIC = {
  DB_LATENCY_HIGH: Number(process.env.HEAL_DB_LATENCY_MS        ?? 800),
  DB_LATENCY_LOW:  Number(process.env.HEAL_DB_LATENCY_OK_MS     ?? 300),
  PENDING_HIGH:    Number(process.env.HEAL_STUCK_THRESHOLD       ?? 500),
  DLQ_SPIKE:       Number(process.env.AUTOPILOT_DLQ_THRESHOLD    ?? 5),
};

// ── Rolling Window ────────────────────────────────────────────────────────────

class RollingWindow {
  private buf: number[] = [];
  constructor(private readonly size: number) {}

  push(v: number): void {
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
  }

  get count(): number { return this.buf.length; }

  avg(): number {
    return this.buf.length === 0
      ? 0
      : this.buf.reduce((a, b) => a + b, 0) / this.buf.length;
  }

  /** Returns the last `n` values in chronological order. */
  tail(n: number): number[] {
    return this.buf.slice(-n);
  }
}

const windows = {
  db_latency:     new RollingWindow(WINDOW_SIZE),
  outbox_pending: new RollingWindow(WINDOW_SIZE),
  dlq_rate:       new RollingWindow(WINDOW_SIZE),
};

// ── Trend Detection ───────────────────────────────────────────────────────────
// Strict monotone: "rising" requires every step to increase; "falling" requires
// every step to decrease.  Anything mixed → "stable".
// This makes false positives very unlikely on 3-point windows.

type Trend = "rising" | "falling" | "stable";

function detectTrend(values: number[]): Trend {
  if (values.length < 2) return "stable";
  let ups   = 0;
  let downs = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) ups++;
    else if (values[i] < values[i - 1]) downs++;
  }
  const steps = values.length - 1;
  if (ups   === steps) return "rising";
  if (downs === steps) return "falling";
  return "stable";
}

// ── Action Effectiveness Memory ───────────────────────────────────────────────
// Stores the last MEM_SIZE self-optimize decisions.  On the cycle after an action
// is taken, `metricAfter` is filled with the current metric value.  This lets us
// measure whether the action actually moved the needle in the next cycle.
//
// Filling rule: every cycle, fillPendingResults() is called BEFORE pushing new
// data — so any record that still has metricAfter=null gets assigned the value
// from this cycle (i.e., the cycle immediately after the action cycle).

interface EffectivenessRecord {
  action:       string;
  metricBefore: number;
  metricAfter:  number | null;   // null = awaiting next-cycle result
}

const memory: EffectivenessRecord[] = [];

// ── Decision A1 state ─────────────────────────────────────────────────────────
// Tracks the 3-cycle evaluation window after each A1 intervention.
//   cooldownCycles  > 0  → A1 is waiting; decremented each cycle; falls through
//                            so Decisions B / C can still act this cycle
//   cooldownCycles === 0 → A1 may fire (or evaluate if it just expired)
//   baselineLatency      → latency recorded at the moment A1 last fired;
//                            used to judge whether the reduction helped

const a1State = {
  cooldownCycles:  0,
  baselineLatency: 0,
};

export function getA1State() {
  return { cooldownCycles: a1State.cooldownCycles, baselineLatency: a1State.baselineLatency };
}

export function rehydrateA1State(s: { cooldownCycles: number; baselineLatency: number }): void {
  a1State.cooldownCycles  = s.cooldownCycles;
  a1State.baselineLatency = s.baselineLatency;
}

function recordAction(action: string, metricBefore: number): void {
  if (memory.length >= MEM_SIZE) memory.shift();
  memory.push({ action, metricBefore, metricAfter: null });
}

/** Fill any pending records with the current metric value (called at cycle start). */
function fillPendingResults(currentLatency: number): void {
  for (const r of memory) {
    if (r.metricAfter === null) r.metricAfter = currentLatency;
  }
}

/**
 * Returns true when the last ≥2 completed records for `action` showed zero
 * improvement — indicating the normal step size is not effective.
 */
function isIneffective(action: string): boolean {
  const completed = memory.filter(r => r.action === action && r.metricAfter !== null);
  if (completed.length < 2) return false;

  const recentTwo = completed.slice(-2);
  const anyImproved = recentTwo.some(r => {
    const before = r.metricBefore;
    const after  = r.metricAfter as number;
    // "reduce" actions succeed when the metric drops; "increase" succeeds when
    // it does not rise (stable or lower counts as acceptable).
    return action.includes("reduce")
      ? after < before
      : after <= before;
  });

  return !anyImproved;
}

// ── Adaptive Threshold Computation ───────────────────────────────────────────
// Falls back to static values while rolling windows are filling (< WINDOW_SIZE).
// Once full, dynamic thresholds are derived from recent averages.
//
// db_latency_high intentionally takes the MIN of static and adaptive so that
// the self-optimize layer conservatively stays below whatever autoHeal uses.

interface AdaptiveThresholds {
  db_latency_high: number;
  db_latency_low:  number;
  pending_high:    number;
  dlq_spike:       number;
  hasAdaptive:     boolean;
  avgLatency:      number;
  avgPending:      number;
  avgDlq:          number;
}

function computeThresholds(): AdaptiveThresholds {
  const ready     = windows.db_latency.count >= WINDOW_SIZE;
  const avgLat    = windows.db_latency.avg();
  const avgPend   = windows.outbox_pending.avg();
  const avgDlq    = windows.dlq_rate.avg();

  return {
    db_latency_high: ready
      ? Math.min(STATIC.DB_LATENCY_HIGH, avgLat * 1.5)
      : STATIC.DB_LATENCY_HIGH,
    db_latency_low: ready
      ? Math.max(0, avgLat * 0.7)
      : STATIC.DB_LATENCY_LOW,
    pending_high: ready
      ? Math.max(STATIC.PENDING_HIGH, avgPend * 1.5)
      : STATIC.PENDING_HIGH,
    dlq_spike: ready
      ? Math.max(STATIC.DLQ_SPIKE, avgDlq * 2)
      : STATIC.DLQ_SPIKE,
    hasAdaptive: ready,
    avgLatency:  avgLat,
    avgPending:  avgPend,
    avgDlq:      avgDlq,
  };
}

// ── Batch nudge helpers ────────────────────────────────────────────────────────

function reduceStep(): number {
  // If recent reduce attempts showed no improvement, fall back to minimum nudge.
  if (isIneffective("reduce_batch_opt")) return REDUCE_STEP_MIN;
  // LATENCY_FIRST: more aggressive reduction (15% vs 10%).
  const factor = getStrategyMode() === "LATENCY_FIRST" ? 0.15 : REDUCE_FACTOR;
  return Math.max(REDUCE_STEP_MIN, Math.floor(getBatchSize() * factor));
}

function increaseStep(): number {
  // THROUGHPUT_FIRST: larger steps to restore processing capacity faster (+2 vs +1).
  return getStrategyMode() === "THROUGHPUT_FIRST" ? 2 : INCREASE_STEP;
}

// ── Observability ─────────────────────────────────────────────────────────────

export function getSelfOptimizeState() {
  return {
    windowsFilled: {
      db_latency:     windows.db_latency.count,
      outbox_pending: windows.outbox_pending.count,
      dlq_rate:       windows.dlq_rate.count,
    },
    averages: {
      db_latency:     Number(windows.db_latency.avg().toFixed(2)),
      outbox_pending: Number(windows.outbox_pending.avg().toFixed(2)),
      dlq_rate:       Number(windows.dlq_rate.avg().toFixed(2)),
    },
    thresholds:        computeThresholds(),
    effectivenessLog:  memory.slice(),
    a1: {
      cooldownCycles:  a1State.cooldownCycles,
      baselineLatency: a1State.baselineLatency,
      evalIn:          a1State.cooldownCycles > 0 ? `${a1State.cooldownCycles} cycles` : "ready",
    },
  };
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function selfOptimize(metrics: CollectedMetrics): Promise<void> {
  // Step 1 — fill any pending effectiveness results using this cycle's latency.
  //          Must happen BEFORE we push new data (so the fill reflects the
  //          next-cycle result of the previous action, not the action cycle itself).
  fillPendingResults(metrics.db_latency);

  // Step 2 — push current metrics into rolling windows.
  windows.db_latency.push(metrics.db_latency);
  windows.outbox_pending.push(metrics.outbox_pending);
  windows.dlq_rate.push(metrics.dlq_rate);

  // Step 3 — need at least TREND_SIZE cycles of data to make any decision.
  if (windows.db_latency.count < TREND_SIZE) return;

  // Step 4 — compute adaptive thresholds and detect trends.
  const t            = computeThresholds();
  const latTrend     = detectTrend(windows.db_latency.tail(TREND_SIZE));
  const pendTrend    = detectTrend(windows.outbox_pending.tail(TREND_SIZE));
  const currentBatch = getBatchSize();

  // ── Decision A: latency strictly rising → gradual reduce ─────────────────
  // Guard: only fires BELOW the high threshold — autoHeal owns the emergency zone.
  // Guard: batch size must have room to reduce.
  // THROUGHPUT_FIRST: skip entirely — we do not reduce batch for latency concerns
  //   when the priority is event throughput.  Return to consume the 1-decision slot
  //   so no lower-priority decision also fires this cycle.
  if (latTrend === "rising" && metrics.db_latency < t.db_latency_high) {
    if (getStrategyMode() === "THROUGHPUT_FIRST") return;  // latency concern suppressed

    if (currentBatch > MIN_BATCH_SIZE) {
      const step  = reduceStep();   // LATENCY_FIRST → 15%, BALANCED → 10%
      const after = Math.max(MIN_BATCH_SIZE, currentBatch - step);

      if (after < currentBatch) {
        if (!requestBatchChange("selfOptimize:reduce_latency", after)) return;
        recordAction("reduce_batch_opt", metrics.db_latency);

        const result =
          `reason=trend_rising latency=${metrics.db_latency}ms avg=${t.avgLatency.toFixed(1)}ms ` +
          `decision=reduce_batch batchSize=${currentBatch}→${after} ` +
          `mode=${getStrategyMode()} adaptive=${t.hasAdaptive} ` +
          `ineffective=${isIneffective("reduce_batch_opt")}`;

        console.info(`[SelfOptimize] ${result}`);
        logIncident({ type: "self_optimize", action: "self_optimize", result });
      }
    }
    return;   // max 1 decision per cycle
  }

  // ── Decision A1: latency elevated above rolling average → small preemptive nudge ──
  // Fires when Decision A did NOT fire (trend is not strictly rising) but the
  // current reading is already ≥130% of the recent rolling average.  Catches
  // plateau elevations and oscillating latency that a 3-point monotone check misses.
  //
  // Evaluate-after-3-cycles contract:
  //   • On fire: arm a1State cooldown (A1_EVAL_CYCLES cycles) and record baseline.
  //   • While cooling: decrement counter each cycle; fall through to B/C (slot free).
  //   • On expiry: evaluate — log whether latency improved; if still elevated, fire again.
  //
  // Step: 5% — half of Decision A.  Conservative because we react to a level,
  //             not a confirmed trend.
  //
  // Guards:
  //   • t.hasAdaptive — avgLatency is only reliable once the 12-cycle window is full.
  //   • latency < db_latency_high — autoHeal owns everything above this.
  //   • THROUGHPUT_FIRST — same exclusion as Decision A.

  // While cooldown is active: tick down and fall through to B / C.
  if (a1State.cooldownCycles > 0) {
    a1State.cooldownCycles--;

    // Expiry cycle — evaluate whether the previous intervention helped.
    if (a1State.cooldownCycles === 0) {
      const improved = metrics.db_latency <= t.avgLatency * 1.3;  // trigger condition now false
      const evalResult =
        `a1_eval baseline=${a1State.baselineLatency}ms current=${metrics.db_latency}ms ` +
        `improved=${improved}`;
      console.info(`[SelfOptimize] ${evalResult}`);
      logIncident({ type: "self_optimize", action: "a1_evaluation", result: evalResult });
      // Fall through — if still elevated A1 will fire again on the next matching cycle.
    }
    // Do NOT consume the 1-decision slot — B and C may still act this cycle.
  } else if (
    t.hasAdaptive                           &&
    metrics.db_latency > t.avgLatency * 1.3 &&
    metrics.db_latency < t.db_latency_high
  ) {
    if (getStrategyMode() === "THROUGHPUT_FIRST") return;

    if (currentBatch > MIN_BATCH_SIZE) {
      const step  = Math.max(REDUCE_STEP_MIN, Math.floor(currentBatch * 0.05));
      const after = Math.max(MIN_BATCH_SIZE, currentBatch - step);

      if (after < currentBatch) {
        if (!requestBatchChange("selfOptimize:reduce_latency_avg", after)) return;
        recordAction("reduce_batch_opt", metrics.db_latency);

        // Arm the evaluate window.
        a1State.cooldownCycles  = A1_EVAL_CYCLES;
        a1State.baselineLatency = metrics.db_latency;

        const result =
          `reason=latency_above_avg latency=${metrics.db_latency}ms ` +
          `avg=${t.avgLatency.toFixed(1)}ms ratio=${(metrics.db_latency / t.avgLatency).toFixed(2)}x ` +
          `decision=reduce_batch batchSize=${currentBatch}→${after} ` +
          `mode=${getStrategyMode()} step=5pct eval_in=${A1_EVAL_CYCLES}_cycles`;

        console.info(`[SelfOptimize] ${result}`);
        logIncident({ type: "self_optimize", action: "self_optimize", result });
      }
    }
    return;   // max 1 decision per cycle
  }

  // ── Decision B: latency strictly falling AND comfortably below low threshold
  //               → gradual increase ─────────────────────────────────────────
  // Guard: batch size must have room to grow.
  // LATENCY_FIRST: skip — do not restore batch capacity while DB is stressed.
  //   Return to consume the slot so Decision C cannot also fire.
  // THROUGHPUT_FIRST: step = +2 instead of +1 (increaseStep() handles this).
  if (latTrend === "falling" && metrics.db_latency < t.db_latency_low) {
    if (getStrategyMode() === "LATENCY_FIRST") return;  // no batch growth under latency pressure

    if (currentBatch < DEFAULT_BATCH_SIZE) {
      const step  = increaseStep();   // THROUGHPUT_FIRST → 2, BALANCED → 1
      const after = Math.min(DEFAULT_BATCH_SIZE, currentBatch + step);

      if (after > currentBatch) {
        if (!requestBatchChange("selfOptimize:increase_latency", after)) return;
        recordAction("increase_batch_opt", metrics.db_latency);

        const result =
          `reason=trend_falling latency=${metrics.db_latency}ms avg=${t.avgLatency.toFixed(1)}ms ` +
          `decision=increase_batch batchSize=${currentBatch}→${after} ` +
          `mode=${getStrategyMode()} adaptive=${t.hasAdaptive}`;

        console.info(`[SelfOptimize] ${result}`);
        logIncident({ type: "self_optimize", action: "self_optimize", result });
      }
    }
    return;   // max 1 decision per cycle
  }

  // ── Decision C: pending queue rising AND approaching DLQ risk ────────────
  // Pre-emptive: acts when pending crosses a fraction of the high threshold AND
  // DLQ is climbing.  Catches queue pile-ups before they trigger autoHeal.
  // Guard: does NOT fire if latency is already above the low threshold (let
  //        autoHeal handle that case instead).
  // THROUGHPUT_FIRST: skip — maximising throughput; reducing batch here is
  //   counter-productive.  autoHeal handles the true emergency.
  // LATENCY_FIRST: tighter trigger — fire at 60% of pending_high (vs 80%)
  //   to shed load sooner while the system is already under latency pressure.
  const mode = getStrategyMode();
  if (mode !== "THROUGHPUT_FIRST" && pendTrend === "rising") {
    const pendFraction = mode === "LATENCY_FIRST" ? 0.60 : 0.80;

    if (
      metrics.outbox_pending > t.pending_high * pendFraction &&
      metrics.dlq_rate       > t.dlq_spike    * 0.5         &&
      metrics.db_latency     < t.db_latency_high             &&
      currentBatch           > MIN_BATCH_SIZE
    ) {
      const step  = reduceStep();
      const after = Math.max(MIN_BATCH_SIZE, currentBatch - step);

      if (after < currentBatch) {
        if (!requestBatchChange("selfOptimize:reduce_pending", after)) return;
        recordAction("reduce_batch_opt", metrics.outbox_pending);

        const result =
          `reason=trend_rising_pending pending=${metrics.outbox_pending} ` +
          `avg_pending=${t.avgPending.toFixed(0)} dlq=${metrics.dlq_rate} ` +
          `decision=reduce_batch batchSize=${currentBatch}→${after} ` +
          `mode=${mode} pendFraction=${pendFraction} adaptive=${t.hasAdaptive}`;

        console.info(`[SelfOptimize] ${result}`);
        logIncident({ type: "self_optimize", action: "self_optimize", result });
      }
    }
    return;   // max 1 decision per cycle
  }

  // No decision this cycle — all conditions stable.
}
