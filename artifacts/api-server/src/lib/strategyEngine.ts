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
// Decision tracking
//   Every cycle we record the full decision context (reason, active constraints,
//   metric trend, running averages) in lastDecision — surfaced via getStrategyState()
//   and exposed by the /api/warroom/status endpoint.
//
// Integration contract
//   • Runs as Step 7 in the autopilot cycle — after globalEvaluator, before learningEngine
//   • Consumers call getStrategyMode() synchronously; no import cycles
//   • autoHeal is NEVER aware of or affected by the current mode
//
// ROLLBACK: remove the step-7 block from autopilot.ts; delete this file.

import { CollectedMetrics }  from "./metricsCollector";
import { logIncident }       from "./incidentStore";
import { isModeSuppressed, type StrategyMode } from "./suppressionRegistry";
import { getCooldownState }  from "./healingEngine";   // safe: healingEngine never imports strategyEngine

// ── Types ─────────────────────────────────────────────────────────────────────

export type { StrategyMode };  // re-export so existing consumers need no import change

export interface StrategyDecision {
  current_mode:       StrategyMode;
  /** Mode computed from raw metric thresholds, before suppression fallback. */
  raw_desired_mode:   StrategyMode;
  /** One-sentence plain-language explanation for operators. */
  narrative:          string;
  /** Operator-facing action status. */
  impact:             "No action required" | "Adjusting system performance";
  /** Human-readable explanation of why this mode was chosen. */
  reason:             string;
  /** Constraints that were evaluated when making this decision. */
  active_constraints: string[];
  /** Numeric context: current and recent-average values + trend direction. */
  decision_context:   {
    latency_ms:      number;
    latency_avg_ms:  number;
    latency_trend:   "rising" | "falling" | "stable";
    pending:         number;
    pending_avg:     number;
    pending_trend:   "rising" | "falling" | "stable";
    dlq_rate:        number;
  };
  decided_at: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_MODE_DWELL = 3;

const LATENCY_HIGH_MS = Number(process.env.STRATEGY_LATENCY_HIGH_MS ?? 400);
const PENDING_HIGH    = Number(process.env.STRATEGY_PENDING_HIGH     ?? 300);

/** Minimum relative change (+/-) to be called a trend (5 %). */
const TREND_THRESHOLD = 0.05;
/** Minimum absolute change (ms) before a rising trend is reported — mirrors globalEvaluator. */
const MIN_ABS_DELTA_TREND_MS = 2;
/** Rolling window size for local trend / avg computation. */
const TREND_WINDOW = 3;

// ── State ─────────────────────────────────────────────────────────────────────

let currentMode:  StrategyMode = "BALANCED";
let cyclesInMode: number       = 0;
let lastDecision: StrategyDecision | null = null;

// Local 3-point rolling windows — avoids importing selfOptimizer (circular risk).
const latencyBuf: number[] = [];
const pendingBuf: number[] = [];

// ── Rolling window helpers ────────────────────────────────────────────────────

function pushWindow(buf: number[], value: number): void {
  buf.push(value);
  if (buf.length > TREND_WINDOW) buf.shift();
}

function avgWindow(buf: number[]): number {
  if (buf.length === 0) return 0;
  return buf.reduce((s, v) => s + v, 0) / buf.length;
}

function trendWindow(buf: number[]): "rising" | "falling" | "stable" {
  if (buf.length < 2) return "stable";
  const first = buf[0];
  const last  = buf[buf.length - 1];
  const denom = Math.max(first, 1);
  const delta = (last - first) / denom;
  if (Math.abs(last - first) >= MIN_ABS_DELTA_TREND_MS
      && delta >  TREND_THRESHOLD) return "rising";
  if (delta < -TREND_THRESHOLD) return "falling";
  return "stable";
}

// ── Decision computation ──────────────────────────────────────────────────────

interface RawDecision {
  rawMode:     StrategyMode;
  finalMode:   StrategyMode;
  reason:      string;
  suppressed:  boolean;
}

function computeDecision(metrics: CollectedMetrics): RawDecision {
  let rawMode: StrategyMode;
  let rawReason: string;

  if (metrics.outbox_pending > PENDING_HIGH) {
    rawMode   = "THROUGHPUT_FIRST";
    rawReason = `pending=${metrics.outbox_pending}>${PENDING_HIGH}`;
  } else if (metrics.db_latency > LATENCY_HIGH_MS) {
    rawMode   = "LATENCY_FIRST";
    rawReason = `latency=${metrics.db_latency}ms>${LATENCY_HIGH_MS}ms`;
  } else {
    rawMode   = "BALANCED";
    rawReason = `latency<${LATENCY_HIGH_MS}ms AND pending<${PENDING_HIGH}`;
  }

  const suppressed = rawMode !== "BALANCED" && isModeSuppressed(rawMode);
  const finalMode  = suppressed ? "BALANCED" : rawMode;

  const reason = suppressed
    ? `${rawReason} (suppressed:${rawMode}→BALANCED)`
    : rawReason;

  return { rawMode, finalMode, reason, suppressed };
}

function buildConstraints(
  rawMode:   StrategyMode,
  decision:  RawDecision,
): string[] {
  const constraints: string[] = [];

  // Suppression
  if (decision.suppressed) {
    constraints.push(`suppressed:${rawMode}`);
  } else {
    constraints.push("no_suppression");
  }

  // Dwell lock
  if (cyclesInMode >= MIN_MODE_DWELL) {
    constraints.push("dwell_satisfied");
  } else {
    constraints.push(`dwell_locked:${MIN_MODE_DWELL - cyclesInMode}_cycles`);
  }

  // Active cooldowns from healingEngine
  const cooldowns = getCooldownState();
  const activeCooldownKeys = Object.keys(cooldowns);
  if (activeCooldownKeys.length === 0) {
    constraints.push("cooldown_clear");
  } else {
    constraints.push(`cooldown_active:${activeCooldownKeys.join(",")}`);
  }

  return constraints;
}

// ── Narrative builder ─────────────────────────────────────────────────────────

function buildNarrative(decision: RawDecision, constraints: string[]): string {
  if (constraints.some(c => c.startsWith("suppressed:"))) {
    return "Strategy constrained — fallback to safe mode.";
  }
  if (constraints.some(c => c.startsWith("cooldown_active"))) {
    return "Recent action in effect — waiting before next adjustment.";
  }
  if (decision.finalMode === "LATENCY_FIRST") {
    return "Latency rising — prioritizing response time over throughput.";
  }
  if (decision.finalMode === "THROUGHPUT_FIRST") {
    return "Backlog increasing — prioritizing processing volume.";
  }
  return "System stable — maintaining balanced performance.";
}

function buildImpact(decision: RawDecision, constraints: string[]): StrategyDecision["impact"] {
  const isActing =
    decision.finalMode !== "BALANCED" ||
    constraints.some(c => c.startsWith("suppressed:") || c.startsWith("cooldown_active"));
  return isActing ? "Adjusting system performance" : "No action required";
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getStrategyMode(): StrategyMode {
  return currentMode;
}

export function rehydrateStrategyMode(mode: StrategyMode): void {
  currentMode  = mode;
  cyclesInMode = 0;
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
    lastDecision,
  };
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function strategyEngine(metrics: CollectedMetrics): Promise<void> {
  // Step 1 — push current metrics into trend windows before making any decision.
  pushWindow(latencyBuf, metrics.db_latency);
  pushWindow(pendingBuf, metrics.outbox_pending);

  // Step 2 — compute desired mode, reason, and suppression status.
  const decision    = computeDecision(metrics);
  const constraints = buildConstraints(decision.rawMode, decision);

  // Step 3 — persist the full decision context every cycle (not just on switch).
  lastDecision = {
    current_mode:       decision.finalMode,
    raw_desired_mode:   decision.rawMode,
    narrative:          buildNarrative(decision, constraints),
    impact:             buildImpact(decision, constraints),
    reason:             decision.reason,
    active_constraints: constraints,
    decision_context: {
      latency_ms:     metrics.db_latency,
      latency_avg_ms: Number(avgWindow(latencyBuf).toFixed(2)),
      latency_trend:  trendWindow(latencyBuf),
      pending:        metrics.outbox_pending,
      pending_avg:    Number(avgWindow(pendingBuf).toFixed(2)),
      pending_trend:  trendWindow(pendingBuf),
      dlq_rate:       metrics.dlq_rate,
    },
    decided_at: new Date().toISOString(),
  };

  // Step 3b — log suppression to incidents table so post-mortem queries are
  // complete without cross-referencing the War Room snapshot.
  if (decision.suppressed) {
    const attemptedMode = decision.rawMode;
    logIncident({
      type:   "strategy_engine",
      action: "mode_suppressed",
      result: `${attemptedMode} → BALANCED`,
    });
  }

  // Step 4 — switch mode if the dwell requirement is met.
  if (decision.finalMode !== currentMode && cyclesInMode >= MIN_MODE_DWELL) {
    const previous = currentMode;
    currentMode    = decision.finalMode;
    cyclesInMode   = 0;

    const result =
      `mode=${decision.finalMode} previous=${previous} ` +
      `reason=${decision.reason} ` +
      `latency=${metrics.db_latency}ms(trend=${lastDecision.decision_context.latency_trend}) ` +
      `pending=${metrics.outbox_pending}(trend=${lastDecision.decision_context.pending_trend}) ` +
      `constraints=[${constraints.join(",")}]`;

    console.info(`[StrategyEngine] mode_switch: ${result}`);
    logIncident({ type: "strategy_engine", action: "mode_switch", result });
  }

  // Always increment regardless of whether a switch happened.
  cyclesInMode++;
}
