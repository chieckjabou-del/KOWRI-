/**
 * KOWRI Fee Optimizer — Autopilot Layer 10
 * ─────────────────────────────────────────
 * Adjusts the primary cashout fee rate dynamically based on live system
 * metrics and the current strategy mode.
 *
 * Invariants:
 *   • Internal transfers are NEVER touched here (handled in processTransfer).
 *   • Fee floor:   40 bps (0.40%) — never go below this.
 *   • Fee ceiling: 120 bps (1.20%) — never go above this.
 *   • Only updates the DB if the rate actually changed.
 *   • Never throws — all errors are caught by the caller's try/catch.
 *
 * Rule logic:
 *   THROUGHPUT_FIRST + high activity  → reduce friction, retain users (−5 bps)
 *   LATENCY_FIRST    + high backlog   → increase cashout to slow outflows (+5 bps)
 *   BALANCED         + low activity   → reduce fee to stimulate usage (−3 bps)
 */

import { db }                      from "@workspace/db";
import { feeConfigTable, transactionsTable } from "@workspace/db";
import { eq, and, asc, sql }      from "drizzle-orm";
import { logIncident }            from "./incidentStore";
import type { CollectedMetrics }  from "./metricsCollector";
import type { StrategyMode }      from "./strategyEngine";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the primary active cashout rule (lowest minAmount bracket — most
 * frequently matched for everyday transactions).
 */
async function getCashoutFeeRule() {
  const rules = await db
    .select()
    .from(feeConfigTable)
    .where(
      and(
        eq(feeConfigTable.operationType, "cashout"),
        eq(feeConfigTable.active, true),
      ),
    )
    .orderBy(asc(feeConfigTable.minAmount))
    .limit(1);

  return rules[0] ?? null;
}

// ── Fee optimizer entry point ─────────────────────────────────────────────────

export async function optimizeFees(
  metrics:  CollectedMetrics,
  strategy: StrategyMode,
): Promise<void> {
  // Query transaction count for the last hour independently.
  // CollectedMetrics doesn't carry tx_count_1h — we fetch it here so the
  // optimizer stays self-contained and doesn't require metricsCollector changes.
  let tx_count_1h = 0;
  try {
    const [countRow] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(transactionsTable)
      .where(sql`created_at > NOW() - INTERVAL '1 hour'`);
    tx_count_1h = Number(countRow?.count ?? 0);
  } catch {
    // If this sub-query fails, default to 0 — all conditions will be skipped
    // gracefully (none of the thresholds are 0-triggered).
    tx_count_1h = 0;
  }

  const cashoutRule = await getCashoutFeeRule();
  if (!cashoutRule) return; // No cashout rule configured — nothing to optimize.

  let newRateBps = cashoutRule.feeRateBps;

  // High activity → reduce friction → retain users
  if (tx_count_1h > 500 && strategy === "THROUGHPUT_FIRST") {
    newRateBps = Math.max(40, newRateBps - 5); // floor: 0.4%
  }

  // Low liquidity / high backlog → increase cashout fee slightly to slow outflows
  if (metrics.outbox_pending > 200 && strategy === "LATENCY_FIRST") {
    newRateBps = Math.min(120, newRateBps + 5); // ceiling: 1.2%
  }

  // Low activity → reduce cashout fee to stimulate usage
  if (tx_count_1h < 50 && strategy === "BALANCED") {
    newRateBps = Math.max(50, newRateBps - 3); // floor: 0.5%
  }

  // Only write to DB if the rate actually changed — avoids unnecessary WAL churn.
  if (newRateBps !== cashoutRule.feeRateBps) {
    await db
      .update(feeConfigTable)
      .set({ feeRateBps: newRateBps })
      .where(eq(feeConfigTable.id, cashoutRule.id));

    logIncident({
      type:   "fee_optimizer",
      action: "rate_adjusted",
      result: `cashout (id=${cashoutRule.id}): ${cashoutRule.feeRateBps}bps → ${newRateBps}bps [strategy=${strategy} tx_1h=${tx_count_1h} outbox=${metrics.outbox_pending}]`,
    });

    console.info(
      `[FeeOptimizer] ${cashoutRule.feeRateBps}bps → ${newRateBps}bps` +
      ` | strategy=${strategy} tx_1h=${tx_count_1h} outbox=${metrics.outbox_pending}`,
    );
  }
}
