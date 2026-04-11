import { Router } from "express";
import { db } from "@workspace/db";
import { riskAlertsTable } from "@workspace/db";
import { eq, desc, count } from "drizzle-orm";

const router = Router();

router.get("/alerts", async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const [alerts, [{ total }]] = await Promise.all([
      db.select().from(riskAlertsTable).orderBy(desc(riskAlertsTable.createdAt)).limit(limit).offset(offset),
      db.select({ total: count() }).from(riskAlertsTable),
    ]);

    return res.json({
      alerts,
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) { return next(err); }
});

router.get("/alerts/stats", async (req, res, next) => {
  try {
    const bySeverity = await db
      .select({ severity: riskAlertsTable.severity, count: count() })
      .from(riskAlertsTable)
      .groupBy(riskAlertsTable.severity);

    const byType = await db
      .select({ alertType: riskAlertsTable.alertType, count: count() })
      .from(riskAlertsTable)
      .groupBy(riskAlertsTable.alertType);

    return res.json({
      bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity, Number(r.count)])),
      byType: Object.fromEntries(byType.map((r) => [r.alertType, Number(r.count)])),
      total: bySeverity.reduce((a, b) => a + Number(b.count), 0),
    });
  } catch (err) { return next(err); }
});

router.get("/alerts/:walletId", async (req, res, next) => {
  try {
    const alerts = await db
      .select()
      .from(riskAlertsTable)
      .where(eq(riskAlertsTable.walletId, req.params.walletId))
      .orderBy(desc(riskAlertsTable.createdAt))
      .limit(50);

    return res.json({ alerts, walletId: req.params.walletId });
  } catch (err) { return next(err); }
});

export default router;
