import { Router } from "express";
import { db } from "@workspace/db";
import { amlFlagsTable, complianceCasesTable } from "@workspace/db";
import { eq, desc, sql, and } from "drizzle-orm";
import { runAmlChecks } from "../lib/amlEngine";
import { requireAdmin } from "../middleware/auth";
import { routeParamString } from "../lib/routeParams";
import { audit } from "../lib/auditLogger";

const router = Router();

// AML data is compliance-only.
router.use(requireAdmin);

type FlagRow = typeof amlFlagsTable.$inferSelect;

// Surfaces amount/currency (stored in metadata) and flagReason at the top level for the dashboard.
function serializeFlag(f: FlagRow) {
  const meta = (f.metadata ?? {}) as Record<string, unknown>;
  return {
    ...f,
    flagReason: f.reason,
    amount: typeof meta.amount === "number" ? meta.amount : meta.amount != null ? Number(meta.amount) : null,
    currency: typeof meta.currency === "string" ? meta.currency : null,
    normalizedXof: typeof meta.normalizedXof === "number" ? meta.normalizedXof : null,
    blocking: meta.blocking === true,
  };
}

router.get("/flags", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const reviewedFilter = req.query.reviewed === "true" ? true : req.query.reviewed === "false" ? false : undefined;
    const where = reviewedFilter === undefined ? undefined : eq(amlFlagsTable.reviewed, reviewedFilter);
    const flags = await db.select().from(amlFlagsTable).where(where).orderBy(desc(amlFlagsTable.createdAt)).limit(limit);
    return res.json({ flags: flags.map(serializeFlag), total: flags.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch AML flags" });
  }
});

router.get("/flags/:walletId", async (req, res) => {
  try {
    const walletId = routeParamString(req, "walletId")!;
    const flags = await db.select()
      .from(amlFlagsTable)
      .where(eq(amlFlagsTable.walletId, walletId))
      .orderBy(desc(amlFlagsTable.createdAt))
      .limit(50);
    return res.json({ flags: flags.map(serializeFlag), total: flags.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch AML flags" });
  }
});

router.patch("/flags/:flagId/review", async (req, res) => {
  try {
    const flagId = routeParamString(req, "flagId")!;
    const { note, operator = "admin" } = req.body ?? {};
    const [updated] = await db.update(amlFlagsTable)
      .set({ reviewed: true })
      .where(and(eq(amlFlagsTable.id, flagId), eq(amlFlagsTable.reviewed, false)))
      .returning();
    if (!updated) {
      const [existing] = await db.select({ id: amlFlagsTable.id }).from(amlFlagsTable).where(eq(amlFlagsTable.id, flagId));
      return res.status(existing ? 409 : 404).json({ error: existing ? "Flag already reviewed" : "Flag not found" });
    }
    await audit({ action: "aml.flag.reviewed", entity: "aml_flag", entityId: flagId, actor: String(operator),
      metadata: { walletId: updated.walletId, reason: updated.reason, note: note ?? null } });
    return res.json({ flag: serializeFlag(updated) });
  } catch (err) {
    return res.status(500).json({ error: "Failed to review flag" });
  }
});

router.post("/check", async (req, res) => {
  try {
    const { walletId, transactionId, amount, currency } = req.body;
    if (!walletId || !transactionId || !amount || !currency) {
      return res.status(400).json({ error: "walletId, transactionId, amount, currency are required" });
    }
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }
    const results = await runAmlChecks(walletId, transactionId, numAmount, currency);
    return res.json({
      checked:  true,
      flagged:  results.length > 0,
      flags:    results,
      walletId,
      transactionId,
    });
  } catch (err) {
    return res.status(500).json({ error: "AML check failed" });
  }
});

router.get("/cases", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const where = status ? eq(complianceCasesTable.status, status) : undefined;
    const cases = await db.select().from(complianceCasesTable).where(where).orderBy(desc(complianceCasesTable.createdAt)).limit(limit);
    return res.json({ cases, total: cases.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch compliance cases" });
  }
});

router.patch("/cases/:id/resolve", async (req, res) => {
  try {
    const caseId = routeParamString(req, "id")!;
    const [updated] = await db.update(complianceCasesTable)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(and(eq(complianceCasesTable.id, caseId), eq(complianceCasesTable.status, "open")))
      .returning();
    if (!updated) {
      const [existing] = await db.select({ id: complianceCasesTable.id }).from(complianceCasesTable).where(eq(complianceCasesTable.id, caseId));
      return res.status(existing ? 409 : 404).json({ error: existing ? "Case already resolved" : "Case not found" });
    }
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: "Failed to resolve case" });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const [flagCount]  = await db.select({ cnt: sql<number>`count(*)` }).from(amlFlagsTable);
    const [unreviewed] = await db.select({ cnt: sql<number>`count(*)` }).from(amlFlagsTable).where(eq(amlFlagsTable.reviewed, false));
    const [caseCount]  = await db.select({ cnt: sql<number>`count(*)` }).from(complianceCasesTable);
    const [openCases]  = await db.select({ cnt: sql<number>`count(*)` })
      .from(complianceCasesTable)
      .where(eq(complianceCasesTable.status, "open"));

    const bySeverity = await db.select({
      severity: amlFlagsTable.severity,
      cnt: sql<number>`count(*)`,
    }).from(amlFlagsTable).groupBy(amlFlagsTable.severity);

    return res.json({
      totalFlags:      Number(flagCount.cnt),
      unreviewedFlags: Number(unreviewed.cnt),
      totalCases:      Number(caseCount.cnt),
      openCases:       Number(openCases.cnt),
      bySeverity:      Object.fromEntries(bySeverity.map((r) => [r.severity, Number(r.cnt)])),
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch AML stats" });
  }
});

export default router;
