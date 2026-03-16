import { Router } from "express";
import { db } from "@workspace/db";
import { eventLogTable, auditLogsTable, idempotencyKeysTable } from "@workspace/db";
import { count, desc } from "drizzle-orm";
import { getMetrics } from "../lib/metrics";
import { STATE_MACHINE_DIAGRAM } from "../lib/stateMachine";

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

    res.json({
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
    next(err);
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

    res.json({
      events,
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    next(err);
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

    res.json({
      logs,
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
