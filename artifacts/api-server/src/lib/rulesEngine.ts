// ── Rules Engine ──────────────────────────────────────────────────────────────
//
// Pure, stateless module.  evaluateRules() takes a metrics snapshot and returns
// one evaluation per rule — no I/O, no side-effects.
//
// Rule lifecycle:
//   triggered  → fire threshold crossed  → autopilot should take action
//   recovered  → metric is back to safe  → autopilot may auto-recover (TRIGGERED only)
//   (neither)  → metric has not changed meaningfully
//
// Thresholds are environment-overridable so operators can tune without deploys:
//   AUTOPILOT_LAG_THRESHOLD_S   default 5   (seconds)
//   AUTOPILOT_DLQ_THRESHOLD     default 5   (dead-letter event count)
//   AUTOPILOT_LATENCY_WARN_MS   default 300 (ms)

import { CollectedMetrics } from "./metricsCollector";

// ── Configurable thresholds ───────────────────────────────────────────────────

const LAG_THRESHOLD_S   = Number(process.env.AUTOPILOT_LAG_THRESHOLD_S  ?? 5);
const DLQ_THRESHOLD     = Number(process.env.AUTOPILOT_DLQ_THRESHOLD     ?? 5);
const LATENCY_WARN_MS   = Number(process.env.AUTOPILOT_LATENCY_WARN_MS   ?? 300);

// ── Types ─────────────────────────────────────────────────────────────────────

export type AutopilotAction =
  | "STOP_TRANSFERS"   // fire outbound_transfers kill switch
  | "FORCE_PRIMARY"    // override dbRouter → all reads go to primary
  | "PAUSE_OUTBOX";    // stop outbox worker dispatch

export interface Rule {
  id:          string;
  description: string;
  metric:      keyof Omit<CollectedMetrics, "collectedAt">;
  action:      AutopilotAction;
  /** Returns true when the metric should trigger the action. */
  shouldFire:  (value: number) => boolean;
  /** Returns true when the metric has recovered enough to lift the switch. */
  shouldRecover: (value: number) => boolean;
  /** Human-readable reason string injected into kill switch + incident log. */
  reason:      (value: number) => string;
}

export interface RuleEvaluation {
  ruleId:    string;
  metric:    string;
  value:     number;
  triggered: boolean;   // condition met — action should fire
  recovered: boolean;   // condition cleared — switch can be auto-recovered
  action:    AutopilotAction;
  reason:    string;
}

// ── Rule definitions ──────────────────────────────────────────────────────────

export const RULES: Rule[] = [
  // ── Rule 1: Ledger imbalance ───────────────────────────────────────────────
  // Any non-zero balance drift means credits ≠ debits — stop all transfers
  // until an engineer investigates.  Recovery: drift returns to 0.
  {
    id:            "balance_drift",
    description:   "Ledger imbalance — halt transfers until balanced",
    metric:        "balance_drift",
    action:        "STOP_TRANSFERS",
    shouldFire:    (v) => v > 0,
    shouldRecover: (v) => v === 0,
    reason:        (v) => `ledger drift=${v.toFixed(4)} — transfers halted`,
  },

  // ── Rule 2: Replica lag ────────────────────────────────────────────────────
  // Lag > threshold means stale reads are possible.  Force all traffic to
  // primary until lag drops back below the threshold.
  // Only meaningful when a replica is configured (replica_lag=0 → rule stays clear).
  {
    id:            "replica_lag",
    description:   `Replica lag > ${LAG_THRESHOLD_S}s — force primary reads`,
    metric:        "replica_lag",
    action:        "FORCE_PRIMARY",
    shouldFire:    (v) => v > LAG_THRESHOLD_S,
    shouldRecover: (v) => v <= LAG_THRESHOLD_S && v >= 0,
    reason:        (v) => `replica lag=${v.toFixed(1)}s > threshold=${LAG_THRESHOLD_S}s`,
  },

  // ── Rule 3: Dead-letter queue ──────────────────────────────────────────────
  // A rising DLQ indicates systematic processing failures.  Pause dispatch so
  // events don't accumulate further while the team investigates.
  // NOTE: this switch requires manual resume — `resumeOutboxWorker("autopilot")`
  //       restarts the interval.  Auto-recovery fires when dead < threshold.
  {
    id:            "dlq_rate",
    description:   `DLQ count >= ${DLQ_THRESHOLD} — pause outbox dispatch`,
    metric:        "dlq_rate",
    action:        "PAUSE_OUTBOX",
    shouldFire:    (v) => v >= DLQ_THRESHOLD,
    shouldRecover: (v) => v < DLQ_THRESHOLD,
    reason:        (v) => `dlq_rate=${v} >= threshold=${DLQ_THRESHOLD}`,
  },
];

// ── Evaluator ─────────────────────────────────────────────────────────────────

/**
 * Pure function — no I/O, no side-effects.
 * Returns one RuleEvaluation per rule in RULES order.
 */
export function evaluateRules(metrics: CollectedMetrics): RuleEvaluation[] {
  return RULES.map(rule => {
    const value     = metrics[rule.metric] as number;
    const triggered = rule.shouldFire(value);
    // "recovered" is only meaningful when the rule is NOT triggered,
    // and the metric has crossed back into the safe zone.
    const recovered = !triggered && rule.shouldRecover(value);

    return {
      ruleId:    rule.id,
      metric:    rule.metric,
      value,
      triggered,
      recovered,
      action:    rule.action,
      reason:    rule.reason(value),
    };
  });
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export function getRulesConfig() {
  return {
    rules: RULES.map(r => ({
      id:          r.id,
      description: r.description,
      metric:      r.metric,
      action:      r.action,
    })),
    thresholds: {
      LAG_THRESHOLD_S,
      DLQ_THRESHOLD,
      LATENCY_WARN_MS,
    },
  };
}
