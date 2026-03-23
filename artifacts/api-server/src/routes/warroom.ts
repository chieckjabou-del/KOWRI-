import { Router } from "express";
import { db } from "@workspace/db";
import { incidentsTable, metricsTable, ledgerEntriesTable, transactionsTable, walletsTable, feeConfigTable } from "@workspace/db";
import { desc, sql, eq, and, asc } from "drizzle-orm";
import { getAllSwitches }           from "../lib/killSwitch";
import { getBatchSize, DEFAULT_BATCH_SIZE } from "../lib/outboxWorker";
import { getStrategyMode, getStrategyState }   from "../lib/strategyEngine";
import { getGlobalEvaluatorState }  from "../lib/globalEvaluator";
import { getSelfOptimizeState }     from "../lib/selfOptimizer";
import { getLearningEngineState }   from "../lib/learningEngine";
import { getAutopilotState, getAutopilotHealth } from "../lib/autopilot";
import { getCooldownState, getHealingImpact }    from "../lib/healingEngine";
import { getLastIncidentTime }                   from "../lib/incidentStore";
import { getBatchControllerState }  from "../lib/batchController";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1_000);
  if (s < 60)    return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  if (m < 60)    return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  if (h < 24)    return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

// ── /warroom/status ───────────────────────────────────────────────────────────
// Returns all live in-memory engine state plus last incident and stability flag.
// No heavy DB aggregations — designed for ≤5 s polling.
router.get("/status", async (_req, res, next) => {
  try {
    const [lastIncident, [{ recentCount }]] = await Promise.all([
      db.select()
        .from(incidentsTable)
        .orderBy(desc(incidentsTable.createdAt))
        .limit(1)
        .then(rows => rows[0] ?? null),
      db.select({ recentCount: sql<number>`COUNT(*)::int` })
        .from(incidentsTable)
        .where(sql`created_at > NOW() - INTERVAL '15 seconds'`),
    ]);

    res.json({
      strategyMode:    getStrategyMode(),
      batchSize:       getBatchSize(),
      killSwitches:    getAllSwitches(),
      lastIncident,
      stable:          Number(recentCount) === 0,
      stableWindow:    "15 s (3 cycles)",
      autopilot:       getAutopilotState(),
      strategy:        getStrategyState(),
      globalEvaluator: getGlobalEvaluatorState(),
      selfOptimize:    getSelfOptimizeState(),
      learningEngine:  getLearningEngineState(),
      activeCooldowns: getCooldownState(),
      updatedAt:       new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ── /warroom/metrics ──────────────────────────────────────────────────────────
// Last 20 data-points per tracked key, ordered oldest→newest for charting.
const TRACKED_KEYS = ["db_latency", "outbox_pending", "dlq_rate", "balance_drift", "replica_lag"];

router.get("/metrics", async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(metricsTable)
      .orderBy(desc(metricsTable.timestamp))
      .limit(TRACKED_KEYS.length * 20 + 20);

    const series: Record<string, { value: number; timestamp: string }[]> = {};
    for (const key of TRACKED_KEYS) series[key] = [];

    for (const row of rows) {
      const bucket = series[row.key];
      if (bucket && bucket.length < 20) {
        bucket.push({
          value:     Number(row.value),
          timestamp: row.timestamp.toISOString(),
        });
      }
    }

    for (const key of TRACKED_KEYS) series[key].reverse();

    res.json({ series, fetchedAt: new Date().toISOString() });
  } catch (err) { next(err); }
});

// ── /warroom/incidents ────────────────────────────────────────────────────────
// Latest incidents with type/action/result/timestamp, plus per-type tally.
router.get("/incidents", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);

    const [incidents, [{ total }]] = await Promise.all([
      db.select()
        .from(incidentsTable)
        .orderBy(desc(incidentsTable.createdAt))
        .limit(limit),
      db.select({ total: sql<number>`COUNT(*)::int` }).from(incidentsTable),
    ]);

    const byType: Record<string, number> = {};
    for (const inc of incidents) {
      byType[inc.type] = (byType[inc.type] ?? 0) + 1;
    }

    res.json({
      incidents,
      total:    Number(total),
      shown:    incidents.length,
      byType,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ── /warroom/live ─────────────────────────────────────────────────────────────
// Five-section decision snapshot: trust score, heartbeat, AI panel,
// money mode, and impact counters.  One DB query; all other fields in-memory.
router.get("/live", async (_req, res, next) => {
  try {
    // ── Gather in-memory state up front (zero DB calls) ───────────────────
    const health      = getAutopilotHealth();
    const allSwitches = getAllSwitches();
    const batchCtrl   = getBatchControllerState();
    const stratState  = getStrategyState();
    const evalState   = getGlobalEvaluatorState();
    const { confidenceMap, predictedHoursCount, hourlyPredictions } = getLearningEngineState();
    const { transactionsProtected } = getHealingImpact();
    const now = Date.now();

    // ── Parallel DB queries: incidents + fee engine + float ───────────────
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    const [
      incidentsAutoResolved,
      feeEngineData,
      floatData,
    ] = await Promise.all([
      // 1. Total auto-resolved incidents (existing query)
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(incidentsTable)
        .where(sql`action LIKE 'recover:%' AND result = 'recovered'`)
        .then(rows => Number(rows[0]?.count ?? 0)),

      // 2. Fee engine metrics
      Promise.all([
        // Cashout rate: primary active cashout rule (lowest minAmount)
        db
          .select({ id: feeConfigTable.id, feeRateBps: feeConfigTable.feeRateBps })
          .from(feeConfigTable)
          .where(and(eq(feeConfigTable.operationType, "cashout"), eq(feeConfigTable.active, true)))
          .orderBy(asc(feeConfigTable.minAmount))
          .limit(1)
          .then(rows => rows[0]?.feeRateBps ?? 0),

        // Revenue today: sum of platform_fees credits since midnight
        db
          .select({ total: sql<number>`COALESCE(SUM(CAST(${ledgerEntriesTable.creditAmount} AS NUMERIC)), 0)` })
          .from(ledgerEntriesTable)
          .where(
            sql`${ledgerEntriesTable.accountId} = 'platform_fees'
              AND ${ledgerEntriesTable.createdAt} >= ${todayMidnight}`,
          )
          .then(rows => Number(rows[0]?.total ?? 0)),

        // Count of fee-generating transactions today (withdrawals with fee entries)
        db
          .select({ count: sql<number>`COUNT(DISTINCT ${ledgerEntriesTable.transactionId})::int` })
          .from(ledgerEntriesTable)
          .where(
            sql`${ledgerEntriesTable.accountId} = 'platform_fees'
              AND CAST(${ledgerEntriesTable.creditAmount} AS NUMERIC) > 0
              AND ${ledgerEntriesTable.createdAt} >= ${todayMidnight}`,
          )
          .then(rows => Number(rows[0]?.count ?? 0)),

        // Free transfer %: P2P transfers as % of all transactions today
        db
          .select({
            total:    sql<number>`COUNT(*)::int`,
            freeOnes: sql<number>`COUNT(*) FILTER (WHERE type = 'transfer')::int`,
          })
          .from(transactionsTable)
          .where(sql`${transactionsTable.createdAt} >= ${todayMidnight}`)
          .then(rows => {
            const total = Number(rows[0]?.total ?? 0);
            const free  = Number(rows[0]?.freeOnes ?? 0);
            return total > 0 ? Math.round((free / total) * 100) : 0;
          }),
      ]).then(([cashoutRateBps, revenueToday, feeTxCount, freeTransferPct]) => ({
        cashoutRateBps,
        revenueToday,
        avgFeePerTx:    feeTxCount > 0 ? Math.round(revenueToday / feeTxCount) : 0,
        freeTransferPct,
      })),

      // 3. Float tracking
      Promise.all([
        // Total active wallet balance
        db
          .select({ total: sql<number>`COALESCE(SUM(CAST(balance AS NUMERIC)), 0)` })
          .from(walletsTable)
          .where(eq(walletsTable.status, "active"))
          .then(rows => Number(rows[0]?.total ?? 0)),

        // Dormant wallet balance: wallets with no transaction (either side) in last 30 days
        db
          .select({ dormant: sql<number>`COALESCE(SUM(CAST(balance AS NUMERIC)), 0)` })
          .from(walletsTable)
          .where(sql`
            status = 'active'
            AND id NOT IN (
              SELECT DISTINCT from_wallet_id FROM transactions
              WHERE from_wallet_id IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'
              UNION
              SELECT DISTINCT to_wallet_id FROM transactions
              WHERE to_wallet_id IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'
            )
          `)
          .then(rows => Number(rows[0]?.dormant ?? 0)),

        // Volume that moved this month (sum of transaction amounts in last 30 days)
        db
          .select({ moved: sql<number>`COALESCE(SUM(CAST(amount AS NUMERIC)), 0)` })
          .from(transactionsTable)
          .where(sql`created_at > NOW() - INTERVAL '30 days' AND status = 'completed'`)
          .then(rows => Number(rows[0]?.moved ?? 0)),
      ]).then(([totalBalance, dormantBalance, movedThisMonth]) => {
        const activeBalance   = Math.max(0, totalBalance - dormantBalance);
        const circulationRate = totalBalance > 0
          ? Math.min(100, Math.round((movedThisMonth / totalBalance) * 100))
          : 0;
        return { totalBalance, dormantBalance, activeBalance, circulationRate };
      }),
    ]);

    // ── 1. TRUST SCORE ─────────────────────────────────────────────────────
    // 4 boolean signals → composite percentage → RELIABLE / DEGRADED / BLIND.
    // stateConsistent proxies the system_state row age via the cycle timestamp
    // (writeAutopilotState fires at the end of every cycle).
    const signals = {
      metricsHealthy:  health.metricsHealthy,
      dbWriteable:     health.dbWriteable,
      cycleRunning:    health.lastCycleEndTime > 0 && (now - health.lastCycleEndTime) < 10_000,
      stateConsistent: health.lastCycleEndTime > 0 && (now - health.lastCycleEndTime) < 15_000,
    };
    const signalCount = Object.values(signals).filter(Boolean).length;
    const trustScore  = {
      value:   Math.round((signalCount / 4) * 100),
      status:  signalCount === 4 ? "RELIABLE" : signalCount >= 2 ? "DEGRADED" : "BLIND",
      signals,
    };

    // ── 2. HEARTBEAT ───────────────────────────────────────────────────────
    const cycleAgeMs  = health.lastCycleEndTime > 0 ? now - health.lastCycleEndTime : null;
    const lastIncMs   = getLastIncidentTime();
    const hasSuppression = Object.keys(evalState.suppressions).length > 0;
    const heartbeat = {
      lastCycleAt:            health.lastCycleEndTime > 0
                                ? new Date(health.lastCycleEndTime).toISOString()
                                : null,
      cycleAgeMs,
      status:                 signals.cycleRunning ? "active" : "stale",
      currentMode:            getStrategyMode(),
      modeValidatedBy:        hasSuppression
                                ? "global_evaluator (suppression active)"
                                : "global_evaluator",
      cyclesSinceLastIncident: lastIncMs > 0
                                ? Math.floor((now - lastIncMs) / 5_000)
                                : null,
    };

    // ── 3. AI DECISION PANEL ───────────────────────────────────────────────
    const anyNonEnabled = allSwitches.some(s => s.state !== "ENABLED");
    const lastDec       = stratState.lastDecision;
    const latTrend      = lastDec?.decision_context.latency_trend  ?? "stable";
    const pendTrend     = lastDec?.decision_context.pending_trend  ?? "stable";
    const confidenceLevel: "HIGH" | "MEDIUM" | "LOW" =
      !anyNonEnabled && latTrend === "stable" && pendTrend === "stable" ? "HIGH" :
      anyNonEnabled  || (latTrend === "rising" && pendTrend === "rising") ? "LOW" :
      "MEDIUM";
    const expectedImpactMap: Record<string, string> = {
      LATENCY_FIRST:    "Batch size being reduced to lower DB write pressure — throughput temporarily constrained",
      THROUGHPUT_FIRST: "Batch throughput increasing to clear outbox queue — monitor DB latency closely",
      BALANCED:         "Steady-state operation — no active throughput or latency adjustment",
    };
    const aiDecisionPanel = {
      confidenceLevel,
      expectedImpact:      expectedImpactMap[stratState.currentMode] ?? "Unknown mode",
      humanReviewRequired: anyNonEnabled,
      currentMode:         stratState.currentMode,
      narrative:           lastDec?.narrative ?? null,
      reason:              lastDec?.reason    ?? null,
    };

    // ── 4. MONEY MODE ──────────────────────────────────────────────────────
    const activeKillSwitches = allSwitches
      .filter(s => s.state !== "ENABLED")
      .map(s => ({ name: s.name, state: s.state, reason: s.reason }));
    const forcedOffActive = activeKillSwitches.filter(k => k.state === "FORCED_OFF");
    const triggeredActive = activeKillSwitches.filter(k => k.state === "TRIGGERED");
    const outboundEnabled = allSwitches.find(s => s.name === "outbound_transfers")?.state === "ENABLED";
    const revenueRiskLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH" =
      !outboundEnabled || batchCtrl.batchPressure < 40 ? "HIGH"   :
      activeKillSwitches.length > 0 || batchCtrl.batchPressure < 70 ? "MEDIUM" :
      batchCtrl.batchPressure < 90  ? "LOW"    :
      "NONE";
    const moneyMode = {
      throughputPressure: batchCtrl.batchPressure,
      revenueRiskLevel,
      causeLayer:         batchCtrl.lockedBy ?? "none",
      activeKillSwitches,
      recoveryEta:        forcedOffActive.length > 0 ? "manual required"    :
                          triggeredActive.length > 0 ? "auto in ~3 cycles"  :
                          "no intervention needed",
    };

    // ── 5. IMPACT COUNTERS ─────────────────────────────────────────────────
    const forcedOffForImpact = allSwitches.filter(s => s.state === "FORCED_OFF");
    const uptimeSinceLastManualIntervention =
      forcedOffForImpact.length === 0
        ? "never required"
        : `${humanDuration(now - Math.max(...forcedOffForImpact.map(s => s.firedAt)))} ago` +
          ` (${forcedOffForImpact.map(s => s.name).join(", ")} still active)`;
    const impact = {
      incidentsAutoResolved,
      manualInterventionsRequired:    forcedOffForImpact.length,
      estimatedTransactionsProtected: transactionsProtected,
      uptimeSinceLastManualIntervention,
    };

    res.json({
      batchSize:       getBatchSize(),
      mode:            getStrategyMode(),
      confidenceMap,
      predictedHoursCount,
      hourlyPredictions,
      batchController: batchCtrl,
      trustScore,
      heartbeat,
      aiDecisionPanel,
      moneyMode,
      impact,
      feeEngine:       feeEngineData,
      float:           floatData,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ── /warroom/snapshot ─────────────────────────────────────────────────────────
// Batches all three endpoints into one round-trip for the dashboard poll.
router.get("/snapshot", async (req, res, next) => {
  try {
    const incidentLimit = Math.min(Number(req.query.incidentLimit) || 30, 100);

    const [statusData, metricsData, incidentData] = await Promise.all([
      // ----- status payload -----
      (async () => {
        const [lastIncident, [{ recentCount }]] = await Promise.all([
          db.select()
            .from(incidentsTable)
            .orderBy(desc(incidentsTable.createdAt))
            .limit(1)
            .then(rows => rows[0] ?? null),
          db.select({ recentCount: sql<number>`COUNT(*)::int` })
            .from(incidentsTable)
            .where(sql`created_at > NOW() - INTERVAL '15 seconds'`),
        ]);
        return {
          strategyMode:    getStrategyMode(),
          batchSize:       getBatchSize(),
          killSwitches:    getAllSwitches(),
          lastIncident,
          stable:          Number(recentCount) === 0,
          stableWindow:    "15 s (3 cycles)",
          autopilot:       getAutopilotState(),
          strategy:        getStrategyState(),
          globalEvaluator: getGlobalEvaluatorState(),
          selfOptimize:    getSelfOptimizeState(),
          learningEngine:  getLearningEngineState(),
          activeCooldowns: getCooldownState(),
        };
      })(),
      // ----- metrics payload -----
      (async () => {
        const rows = await db
          .select()
          .from(metricsTable)
          .orderBy(desc(metricsTable.timestamp))
          .limit(TRACKED_KEYS.length * 20 + 20);

        const series: Record<string, { value: number; timestamp: string }[]> = {};
        for (const key of TRACKED_KEYS) series[key] = [];
        for (const row of rows) {
          const bucket = series[row.key];
          if (bucket && bucket.length < 20) {
            bucket.push({ value: Number(row.value), timestamp: row.timestamp.toISOString() });
          }
        }
        for (const key of TRACKED_KEYS) series[key].reverse();
        return { series };
      })(),
      // ----- incidents payload -----
      (async () => {
        const [incidents, [{ total }]] = await Promise.all([
          db.select()
            .from(incidentsTable)
            .orderBy(desc(incidentsTable.createdAt))
            .limit(incidentLimit),
          db.select({ total: sql<number>`COUNT(*)::int` }).from(incidentsTable),
        ]);
        const byType: Record<string, number> = {};
        for (const inc of incidents) byType[inc.type] = (byType[inc.type] ?? 0) + 1;
        return { incidents, total: Number(total), shown: incidents.length, byType };
      })(),
    ]);

    res.json({
      status:    statusData,
      metrics:   metricsData,
      incidents: incidentData,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ── /warroom/impact ───────────────────────────────────────────────────────────
// Business impact summary for non-technical operators.
// Answers: how many times did the autopilot self-correct, and what is the cost
// of any remaining manual interventions?
router.get("/impact", async (_req, res, next) => {
  try {
    const [autoResolved, totalFired] = await Promise.all([
      db.select({ count: sql<number>`COUNT(*)::int` })
        .from(incidentsTable)
        .where(sql`action LIKE 'recover:%' AND result = 'recovered'`)
        .then(rows => Number(rows[0]?.count ?? 0)),
      db.select({ count: sql<number>`COUNT(*)::int` })
        .from(incidentsTable)
        .where(sql`result = 'fired'`)
        .then(rows => Number(rows[0]?.count ?? 0)),
    ]);

    const switches = getAllSwitches() as Record<string, { state: string; updatedAt?: string }>;
    const forcedOff = Object.entries(switches)
      .filter(([, s]) => s.state === "FORCED_OFF")
      .map(([name]) => name);

    // Rough lower-bound: each auto-recovery prevented at least one full batch
    // worth of transactions from being blocked for the recovery window.
    const estimatedTransactionsProtected = autoResolved * DEFAULT_BATCH_SIZE;

    const uptimeSinceLastManualIntervention =
      forcedOff.length === 0
        ? "No manual interventions active — all switches are operator-clear"
        : `${forcedOff.length} switch(es) currently FORCED_OFF (manual lift required): ${forcedOff.join(", ")}`;

    res.json({
      incidentsAutoResolved:              autoResolved,
      manualInterventionsRequired:        forcedOff.length,
      forcedOffSwitches:                  forcedOff,
      estimatedTransactionsProtected,
      uptimeSinceLastManualIntervention,
      totalKillSwitchFireEvents:          totalFired,
      fetchedAt:                          new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

export default router;
