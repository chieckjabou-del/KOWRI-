import { Router } from "express";
import { db } from "@workspace/db";
import { eventLogTable, auditLogsTable, idempotencyKeysTable, sagasTable, riskAlertsTable, settlementsTable, serviceTracesTable, messageQueueTable, amlFlagsTable, connectorsTable, ledgerShardsTable, outboxEventsTable } from "@workspace/db";
import { getOutboxStats } from "../lib/outboxWorker";
import { getReplicaStats } from "../lib/dbRouter";
import { getStickyStoreStats } from "../middleware/stickyPrimary";
import { getAdvisorStats } from "../lib/windowAdvisor";
import { count, desc, sql } from "drizzle-orm";
import { getMetrics } from "../lib/metrics";
import { STATE_MACHINE_DIAGRAM } from "../lib/stateMachine";
import { tracer } from "../lib/tracer";
import { messageQueue } from "../lib/messageQueue";
import { SERVICES } from "../services/index";

const router = Router();

router.get("/metrics", async (req, res, next) => {
  try {
    const [
      [{ totalEvents }],
      [{ totalAuditLogs }],
      [{ totalIdempotencyKeys }],
      recentEvents,
    ] = await Promise.all([
      db.select({ totalEvents: count() }).from(eventLogTable),
      db.select({ totalAuditLogs: count() }).from(auditLogsTable),
      db.select({ totalIdempotencyKeys: count() }).from(idempotencyKeysTable),
      db.select().from(eventLogTable).orderBy(desc(eventLogTable.createdAt)).limit(5),
    ]);

    const metrics = getMetrics();

    return res.json({
      ...metrics,
      persistence: {
        totalEventsLogged: Number(totalEvents),
        totalAuditLogs: Number(totalAuditLogs),
        totalIdempotencyKeys: Number(totalIdempotencyKeys),
      },
      recentEvents: recentEvents.map((e) => ({
        id: e.id,
        type: e.eventType,
        createdAt: e.createdAt,
      })),
      stateMachine: STATE_MACHINE_DIAGRAM,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/events", async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const [events, [{ total }]] = await Promise.all([
      db.select().from(eventLogTable).orderBy(desc(eventLogTable.createdAt)).limit(limit).offset(offset),
      db.select({ total: count() }).from(eventLogTable),
    ]);

    return res.json({
      events,
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/audit", async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const [logs, [{ total }]] = await Promise.all([
      db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.timestamp)).limit(limit).offset(offset),
      db.select({ total: count() }).from(auditLogsTable),
    ]);

    return res.json({
      logs,
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/health", async (_req, res, next) => {
  try {
    const healthStart = Date.now();

    const dbStart = Date.now();
    await db.execute(sql`SELECT 1`);
    const dbLatencyMs = Date.now() - dbStart;

    const [
      [{ totalLedger }],
      ledgerBalance,
      [{ pendingSagas }],
      [{ pendingSettlements }],
      [{ openAlerts }],
    ] = await Promise.all([
      db.select({ totalLedger: count() }).from(eventLogTable),
      db.execute(sql`
        SELECT
          COALESCE(SUM(CAST(credit_amount AS NUMERIC)), 0) AS credits,
          COALESCE(SUM(CAST(debit_amount AS NUMERIC)), 0) AS debits
        FROM ledger_entries
      `),
      db.select({ pendingSagas: count() }).from(sagasTable).where(sql`status IN ('started','in_progress')`),
      db.select({ pendingSettlements: count() }).from(settlementsTable).where(sql`status IN ('pending','processing')`),
      db.select({ openAlerts: count() }).from(riskAlertsTable).where(sql`resolved = false`),
    ]);

    const ledgerRow = (ledgerBalance as any).rows?.[0];
    const credits = Number(ledgerRow?.credits ?? 0);
    const debits  = Number(ledgerRow?.debits ?? 0);
    const ledgerDrift = Math.abs(credits - debits);
    const ledgerIntact = ledgerDrift < 0.01;

    const mem = process.memoryUsage();
    const uptimeSec = Math.floor(process.uptime());

    const status = dbLatencyMs < 500 && ledgerIntact ? "healthy" : "degraded";

    return res.json({
      status,
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - healthStart,
      components: {
        database: {
          status: dbLatencyMs < 500 ? "healthy" : "slow",
          latencyMs: dbLatencyMs,
        },
        eventBus: {
          status: "healthy",
          totalEventsLogged: Number(totalLedger),
        },
        ledger: {
          status: ledgerIntact ? "balanced" : "drift_detected",
          totalCredits: credits,
          totalDebits: debits,
          drift: ledgerDrift,
        },
        queues: {
          pendingSagas: Number(pendingSagas),
          pendingSettlements: Number(pendingSettlements),
          openFraudAlerts: Number(openAlerts),
        },
        memory: {
          heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
          rssM: Math.round(mem.rss / 1024 / 1024),
        },
        uptime: {
          seconds: uptimeSec,
          human: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`,
        },
      },
    });
  } catch (err) { return next(err); }
});

router.get("/replica/status", (_req, res) => {
  return res.json({ ...getReplicaStats(), stickyStore: getStickyStoreStats() });
});

router.get("/sticky/advisor", (_req, res) => {
  return res.json(getAdvisorStats());
});

router.get("/outbox/status", async (req, res, next) => {
  try {
    const stats = await getOutboxStats();
    const [{ eventLogTotal }] = await db.select({ eventLogTotal: count() }).from(eventLogTable);
    const phase = process.env.OUTBOX_ONLY === "true" ? 3
                : process.env.OUTBOX_ENABLED === "true" ? 1 : 0;

    const ready = stats.pending === 0 && stats.dead === 0;

    return res.json({
      phase,
      ready,
      outbox: stats,
      eventLogTotal:   Number(eventLogTotal),
      bufferDisabled:  phase === 3,
      alerts: [
        ...(stats.dead    > 0  ? [`${stats.dead} dead-letter event(s) — manual replay required`] : []),
        ...(stats.pending > 50 ? [`outbox backlog ${stats.pending} — worker may be stalled`]     : []),
      ],
    });
  } catch (err) { return next(err); }
});

// ── Snapshot — batches all 4 war-room endpoints into one round-trip ───────────
// ROLLBACK: delete this route; revert war-room.tsx to 4 individual useQuery calls.
router.get("/snapshot", async (_req, res, next) => {
  try {
    const [health, outboxStats, replicaStats, advisorStats] = await Promise.all([
      (async () => {
        const dbStart = Date.now();
        let dbOk = true;
        try { await db.execute(sql`SELECT 1`); } catch { dbOk = false; }
        const dbLatencyMs = Date.now() - dbStart;
        const dbStatus    = dbOk && dbLatencyMs < 500 ? "healthy" : "degraded";

        const [[{ pendingSagas }], [{ pendingSettlements }], [{ openFraudAlerts }]] =
          await Promise.all([
            db.select({ pendingSagas:       count() }).from(sagasTable)    .where(sql`status IN ('started','in_progress')`),
            db.select({ pendingSettlements: count() }).from(settlementsTable).where(sql`status IN ('pending','processing')`),
            db.select({ openFraudAlerts:    count() }).from(riskAlertsTable) .where(sql`resolved = false`),
          ]);

        return {
          latencyMs:  dbLatencyMs,
          status:     dbStatus,
          components: {
            database: { status: dbStatus, latencyMs: dbLatencyMs },
            queues:   {
              pendingSagas:       Number(pendingSagas),
              pendingSettlements: Number(pendingSettlements),
              openFraudAlerts:    Number(openFraudAlerts),
            },
          },
        };
      })(),
      getOutboxStats(),
      Promise.resolve({ ...getReplicaStats(), stickyStore: getStickyStoreStats() }),
      Promise.resolve(getAdvisorStats()),
    ]);

    return res.json({
      health:  health,
      outbox:  { outbox: outboxStats },
      replica: replicaStats,
      advisor: advisorStats,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) { return next(err); }
});

router.get("/tracing", async (req, res, next) => {
  try {
    const traceId = req.query.traceId as string | undefined;
    const graph   = await tracer.getCallGraph(traceId);
    const mqStats = messageQueue.getStats();

    const [traceCount]  = await db.select({ cnt: count() }).from(serviceTracesTable);
    const [mqCount]     = await db.select({ cnt: count() }).from(messageQueueTable);

    return res.json({
      ...graph,
      services:     SERVICES,
      tracingMode:  "distributed",
      sampleRate:   1.0,
      messageQueue: { ...mqStats, totalMessages: Number(mqCount.cnt) },
      totalTraces:  Number(traceCount.cnt),
    });
  } catch (err) { return next(err); }
});

export default router;
