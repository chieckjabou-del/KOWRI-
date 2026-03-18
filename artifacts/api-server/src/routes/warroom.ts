import { Router } from "express";
import { db } from "@workspace/db";
import { incidentsTable, metricsTable } from "@workspace/db";
import { desc, sql } from "drizzle-orm";
import { getAllSwitches }           from "../lib/killSwitch";
import { getBatchSize, DEFAULT_BATCH_SIZE } from "../lib/outboxWorker";
import { getStrategyMode, getStrategyState }   from "../lib/strategyEngine";
import { getGlobalEvaluatorState }  from "../lib/globalEvaluator";
import { getSelfOptimizeState }     from "../lib/selfOptimizer";
import { getLearningEngineState }   from "../lib/learningEngine";
import { getAutopilotState }        from "../lib/autopilot";
import { getCooldownState, getHealingImpact } from "../lib/healingEngine";
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
// Fast decision-state snapshot plus business impact summary.
// One DB query (incidents auto-resolved count); all other fields are in-memory.
router.get("/live", async (_req, res, next) => {
  try {
    const { confidenceMap, predictedHoursCount, hourlyPredictions } = getLearningEngineState();

    // Single DB query: count auto-resolved incidents (recover:* actions that succeeded).
    const incidentsAutoResolved = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(incidentsTable)
      .where(sql`action LIKE 'recover:%' AND result = 'recovered'`)
      .then(rows => Number(rows[0]?.count ?? 0));

    // FORCED_OFF switches represent currently active manual interventions.
    const switches     = getAllSwitches();
    const forcedOff    = switches.filter(s => s.state === "FORCED_OFF");
    const manualInterventionsRequired = forcedOff.length;

    // Running accumulator maintained by healingEngine: sum of batch sizes shed
    // via emergency reduce_batch instead of firing STOP_TRANSFERS.
    const { transactionsProtected: estimatedTransactionsProtected } = getHealingImpact();

    // Human-readable time since the most recent manual intervention was set.
    // "never required" when all switches are currently ENABLED or TRIGGERED (auto-managed).
    let uptimeSinceLastManualIntervention: string;
    if (forcedOff.length === 0) {
      uptimeSinceLastManualIntervention = "never required";
    } else {
      const mostRecentFiredAt = Math.max(...forcedOff.map(s => s.firedAt));
      uptimeSinceLastManualIntervention =
        `${humanDuration(Date.now() - mostRecentFiredAt)} ago` +
        ` (${forcedOff.map(s => s.name).join(", ")} still active)`;
    }

    res.json({
      batchSize:       getBatchSize(),
      mode:            getStrategyMode(),
      confidenceMap,
      predictedHoursCount,
      hourlyPredictions,
      batchController: getBatchControllerState(),
      impact: {
        incidentsAutoResolved,
        manualInterventionsRequired,
        estimatedTransactionsProtected,
        uptimeSinceLastManualIntervention,
      },
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
