import { Router } from "express";
import { db } from "@workspace/db";
import { incidentsTable, metricsTable } from "@workspace/db";
import { desc, sql } from "drizzle-orm";
import { getAllSwitches }           from "../lib/killSwitch";
import { getBatchSize }             from "../lib/outboxWorker";
import { getStrategyMode, getStrategyState }   from "../lib/strategyEngine";
import { getGlobalEvaluatorState }  from "../lib/globalEvaluator";
import { getSelfOptimizeState }     from "../lib/selfOptimizer";
import { getLearningEngineState }   from "../lib/learningEngine";
import { getAutopilotState }        from "../lib/autopilot";
import { getCooldownState }         from "../lib/healingEngine";

const router = Router();

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

export default router;
