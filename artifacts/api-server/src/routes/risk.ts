import { Router } from "express";
import { db } from "@workspace/db";
import { riskAlertsTable } from "@workspace/db";
import { eq, desc, count, and } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth";
import { routeParamString } from "../lib/routeParams";
import { audit } from "../lib/auditLogger";

const router = Router();

// Risk alerts expose customer activity: operators only.
router.use(requireAdmin);

router.get("/alerts", async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const resolvedFilter = req.query.resolved === "true" ? true : req.query.resolved === "false" ? false : undefined;
    const where = resolvedFilter === undefined ? undefined : eq(riskAlertsTable.resolved, resolvedFilter);

    const [alerts, [{ total }]] = await Promise.all([
      db.select().from(riskAlertsTable).where(where).orderBy(desc(riskAlertsTable.createdAt)).limit(limit).offset(offset),
      db.select({ total: count() }).from(riskAlertsTable).where(where),
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

    const [{ open }] = await db.select({ open: count() }).from(riskAlertsTable).where(eq(riskAlertsTable.resolved, false));

    return res.json({
      bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity, Number(r.count)])),
      byType: Object.fromEntries(byType.map((r) => [r.alertType, Number(r.count)])),
      total: bySeverity.reduce((a, b) => a + Number(b.count), 0),
      open: Number(open),
    });
  } catch (err) { return next(err); }
});

router.get("/alerts/:walletId", async (req, res, next) => {
  try {
    const walletId = routeParamString(req, "walletId")!;
    const alerts = await db
      .select()
      .from(riskAlertsTable)
      .where(eq(riskAlertsTable.walletId, walletId))
      .orderBy(desc(riskAlertsTable.createdAt))
      .limit(50);

    return res.json({ alerts, walletId });
  } catch (err) { return next(err); }
});

router.patch("/alerts/:alertId/resolve", async (req, res, next) => {
  try {
    const alertId = routeParamString(req, "alertId")!;
    const { resolution, operator = "admin" } = req.body ?? {};
    const [updated] = await db.update(riskAlertsTable)
      .set({ resolved: true })
      .where(and(eq(riskAlertsTable.id, alertId), eq(riskAlertsTable.resolved, false)))
      .returning();
    if (!updated) {
      const [existing] = await db.select({ id: riskAlertsTable.id }).from(riskAlertsTable).where(eq(riskAlertsTable.id, alertId));
      return res.status(existing ? 409 : 404).json({ error: existing ? "Alert already resolved" : "Alert not found" });
    }
    await audit({ action: "risk.alert.resolved", entity: "risk_alert", entityId: alertId, actor: String(operator),
      metadata: { walletId: updated.walletId, alertType: updated.alertType, resolution: resolution ?? null } });
    return res.json({ alert: updated });
  } catch (err) { return next(err); }
});

export default router;
