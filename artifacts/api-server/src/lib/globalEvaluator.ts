// ── Global Evaluator ──────────────────────────────────────────────────────────
//
// Audits whether the strategy engine's mode decisions are producing measurable
// improvement.  Runs BEFORE strategyEngine so that suppression flags are in
// place when strategyEngine computes the mode for this cycle.
//
// Evaluation logic
//   THROUGHPUT_FIRST success: pending net-improved over the last 3 cycles
//   LATENCY_FIRST    success: latency net-improved over the last 3 cycles
//   BALANCED         success: neither metric worsened by more than 10%
//
// Failure adaptation
//   1st consecutive failure → suppress that mode for BLOCK_SHORT (1) cycle
//   2nd consecutive failure → suppress that mode for BLOCK_LONG  (5) cycles
//   Any success              → reset failure counter to 0
//
// Integration contract
//   • isModeSuppressed(mode) lives in suppressionRegistry.ts — no import cycle
//   • autoHeal is NEVER aware of evaluator state — kill switches untouched
//
// ROLLBACK: remove step-6 block from autopilot.ts; delete this file.
//           Remove isModeSuppressed import from strategyEngine.ts.

import { CollectedMetrics } from "./metricsCollector";
import { getStrategyMode }                                                                 from "./strategyEngine";
import { type StrategyMode, incrementCycle, getCycleCount, suppressMode, clearSuppressions, getBlockedUntil } from "./suppressionRegistry";
import { logIncident }      from "./incidentStore";

// ── Constants ─────────────────────────────────────────────────────────────────

const WINDOW_SIZE     = 6;    // total rolling window retained
const MIN_EVAL_CYCLES = 3;    // mode must be active this many cycles before evaluating
const BLOCK_SHORT     = 1;    // cycles to suppress on 1st failure
const BLOCK_LONG      = 5;    // cycles to suppress on 2nd (repeated) failure
const FAILURE_THRESHOLD = 2;  // consecutive failures before long suppression
const BALANCED_NOISE    = 0.10; // 10% worsening tolerance for BALANCED success check
const MIN_ABS_DELTA_MS  = 2;   // minimum absolute change (ms) before worsening is counted

// ── State ─────────────────────────────────────────────────────────────────────
// cycleCount and blockedUntil live in suppressionRegistry (breaks the former
// globalEvaluator ↔ strategyEngine circular import).

const latencyWindow: number[]      = [];
const pendingWindow: number[]      = [];
const modeHistory:   StrategyMode[] = [];

/** Consecutive failure count per mode.  Reset to 0 on any success. */
const failureCount = new Map<StrategyMode, number>();

/** Last result string emitted to console.  Guards against flooding identical lines. */
let lastLoggedResult: string | null = null;

// ── Global state rehydration ──────────────────────────────────────────────────

export function rehydrateGlobalState(state: {
  modeHistory:  StrategyMode[];
  failureCount: Record<string, number>;
  blockedUntil: Record<string, number>;   // remaining cycles (relative to cycle 0)
}): void {
  modeHistory.length = 0;
  modeHistory.push(...state.modeHistory.slice(-WINDOW_SIZE));

  failureCount.clear();
  for (const [mode, count] of Object.entries(state.failureCount)) {
    failureCount.set(mode as StrategyMode, count);
  }

  clearSuppressions();
  for (const [mode, remaining] of Object.entries(state.blockedUntil)) {
    if (remaining > 0) {
      // getCycleCount() is 0 at startup; absolute expiry = 0 + remaining = remaining
      suppressMode(mode as StrategyMode, getCycleCount() + remaining);
    }
  }
}

// ── Rolling window helpers ─────────────────────────────────────────────────────

function pushWindow(arr: number[], value: number): void {
  arr.push(value);
  if (arr.length > WINDOW_SIZE) arr.shift();
}

function pushModeHistory(mode: StrategyMode): void {
  modeHistory.push(mode);
  if (modeHistory.length > WINDOW_SIZE) modeHistory.shift();
}

// ── Consecutive current-mode counter ─────────────────────────────────────────
// Derived from the tail of modeHistory.  Includes the current cycle because
// we push the mode before calling this.

function consecutiveCurrentMode(): number {
  if (modeHistory.length === 0) return 0;
  const current = modeHistory[modeHistory.length - 1];
  let count = 0;
  for (let i = modeHistory.length - 1; i >= 0; i--) {
    if (modeHistory[i] === current) count++;
    else break;
  }
  return count;
}

// ── Trend helpers ─────────────────────────────────────────────────────────────

/** Net improvement: last value ≤ first value (no noise buffer — any improvement counts). */
function netImproved(values: number[]): boolean {
  return values.length >= 2 && values[values.length - 1] <= values[0];
}

/** Net worsening: last value > first value by more than BALANCED_NOISE fraction. */
function netWorsened(values: number[]): boolean {
  if (values.length < 2) return false;
  const last = values.length - 1;
  return (
    Math.abs(values[last] - values[0]) >= MIN_ABS_DELTA_MS &&
    values[last] > values[0] * (1 + BALANCED_NOISE)
  );
}

/** Human-readable trend label used in incident result strings. */
function trendLabel(values: number[]): string {
  if (values.length < 2) return "unknown";
  const delta = values[values.length - 1] - values[0];
  if (delta < 0) return "falling";
  if (delta > values[0] * BALANCED_NOISE) return "rising";
  return "stable";
}

// ── Success evaluation ────────────────────────────────────────────────────────

function evaluateSuccess(
  mode: StrategyMode,
  latLast: number[],
  pendLast: number[],
): boolean {
  switch (mode) {
    case "THROUGHPUT_FIRST":
      // Success: pending went down or held flat — queue is clearing.
      return netImproved(pendLast);

    case "LATENCY_FIRST":
      // Success: latency went down or held flat — DB pressure easing.
      return netImproved(latLast);

    case "BALANCED":
      // Success: neither metric worsened significantly.
      return !netWorsened(latLast) && !netWorsened(pendLast);
  }
}

// ── Observability ─────────────────────────────────────────────────────────────

export function getGlobalEvaluatorState() {
  const curCycle = getCycleCount();
  return {
    cycleCount: curCycle,
    windowsFilled: {
      latency: latencyWindow.length,
      pending: pendingWindow.length,
      mode:    modeHistory.length,
    },
    modeHistory:   modeHistory.slice(),
    failureCount:  Object.fromEntries(failureCount),
    suppressions: Object.fromEntries(
      Array.from(getBlockedUntil().entries())
        .filter(([, exp]) => curCycle < exp)
        .map(([mode, exp]) => [mode, { expiresAtCycle: exp, remainingCycles: exp - curCycle }]),
    ),
  };
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function globalEvaluator(metrics: CollectedMetrics): Promise<void> {
  // Step 1 — advance cycle counter (used by suppressionRegistry.isModeSuppressed comparisons).
  const cycleCount = incrementCycle();

  // Step 2 — record the current mode BEFORE strategyEngine runs for this cycle.
  //          This captures the mode that was in effect when metrics were collected.
  const mode = getStrategyMode();
  pushModeHistory(mode);
  pushWindow(latencyWindow, metrics.db_latency);
  pushWindow(pendingWindow, metrics.outbox_pending);

  // Step 3 — need MIN_EVAL_CYCLES consecutive cycles in this mode AND enough
  //          window data before making any judgement.
  const consecutive = consecutiveCurrentMode();
  if (consecutive < MIN_EVAL_CYCLES)      return;
  if (latencyWindow.length < MIN_EVAL_CYCLES) return;

  // Step 4 — evaluate success/failure against the last MIN_EVAL_CYCLES readings.
  const latLast  = latencyWindow.slice(-MIN_EVAL_CYCLES);
  const pendLast = pendingWindow.slice(-MIN_EVAL_CYCLES);
  const success  = evaluateSuccess(mode, latLast, pendLast);

  const latTrend  = trendLabel(latLast);
  const pendTrend = trendLabel(pendLast);
  const currentFailures = failureCount.get(mode) ?? 0;

  // Step 5 — update failure/success counters and apply suppression if needed.
  let suppressionApplied = "none";

  if (success) {
    failureCount.set(mode, 0);
  } else {
    const newCount = currentFailures + 1;
    failureCount.set(mode, newCount);

    if (newCount >= FAILURE_THRESHOLD) {
      // Repeated failure — long suppression.  Reset counter so the next block
      // starts fresh after the suppression expires.
      suppressMode(mode, cycleCount + BLOCK_LONG);
      failureCount.set(mode, 0);
      suppressionApplied = `block_long_${BLOCK_LONG}_cycles`;
      console.warn(
        `[GlobalEvaluator] mode=${mode} suppressed for ${BLOCK_LONG} cycles ` +
        `(repeated_failure failureCount=${newCount})`,
      );
    } else {
      // First failure — short suppression (single-cycle downgrade to BALANCED).
      suppressMode(mode, cycleCount + BLOCK_SHORT);
      suppressionApplied = `block_short_${BLOCK_SHORT}_cycle`;
      console.warn(
        `[GlobalEvaluator] mode=${mode} downgraded to BALANCED for ${BLOCK_SHORT} cycle ` +
        `(failure_count=${newCount})`,
      );
    }
  }

  // Step 6 — log evaluation result.
  const reason = success
    ? "improvement_observed"
    : suppressionApplied === "none"
    ? "no_improvement"
    : `no_improvement→${suppressionApplied}`;

  const result =
    `mode=${mode} success=${success} reason=${reason} ` +
    `latencyTrend=${latTrend} pendingTrend=${pendTrend} ` +
    `consecutiveCycles=${consecutive} failureCount=${currentFailures}`;

  if (result !== lastLoggedResult) {
    console.info(`[GlobalEvaluator] strategy_validation: ${result}`);
    lastLoggedResult = result;
  }
  if (success === true) return; // invariant: suppressionApplied is always !== "none" when success === false
  logIncident({ type: "global_evaluator", action: "strategy_validation", result });
}
