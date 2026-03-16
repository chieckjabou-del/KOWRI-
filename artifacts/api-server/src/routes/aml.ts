import { Router } from "express";
import { db } from "@workspace/db";
import { amlFlagsTable, complianceCasesTable } from "@workspace/db";
import { eq, desc, sql, count } from "drizzle-orm";
import { runAmlChecks } from "../lib/amlEngine";

const router = Router();

router.get("/flags", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const flags = await db.select().from(amlFlagsTable).orderBy(desc(amlFlagsTable.createdAt)).limit(limit);
    res.json({ flags, total: flags.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch AML flags" });
  }
});

router.get("/flags/:walletId", async (req, res) => {
  try {
    const flags = await db.select()
      .from(amlFlagsTable)
      .where(eq(amlFlagsTable.walletId, req.params.walletId))
      .orderBy(desc(amlFlagsTable.createdAt))
      .limit(50);
    res.json({ flags, total: flags.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch AML flags" });
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
    res.json({
      checked:  true,
      flagged:  results.length > 0,
      flags:    results,
      walletId,
      transactionId,
    });
  } catch (err) {
    res.status(500).json({ error: "AML check failed" });
  }
});

router.get("/cases", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const cases = await db.select().from(complianceCasesTable).orderBy(desc(complianceCasesTable.createdAt)).limit(limit);
    res.json({ cases, total: cases.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch compliance cases" });
  }
});

router.patch("/cases/:id/resolve", async (req, res) => {
  try {
    const [updated] = await db.update(complianceCasesTable)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(complianceCasesTable.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Case not found" });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to resolve case" });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const [flagCount]  = await db.select({ cnt: sql<number>`count(*)` }).from(amlFlagsTable);
    const [caseCount]  = await db.select({ cnt: sql<number>`count(*)` }).from(complianceCasesTable);
    const [openCases]  = await db.select({ cnt: sql<number>`count(*)` })
      .from(complianceCasesTable)
      .where(eq(complianceCasesTable.status, "open"));

    const bySeverity = await db.select({
      severity: amlFlagsTable.severity,
      cnt: sql<number>`count(*)`,
    }).from(amlFlagsTable).groupBy(amlFlagsTable.severity);

    res.json({
      totalFlags:  Number(flagCount.cnt),
      totalCases:  Number(caseCount.cnt),
      openCases:   Number(openCases.cnt),
      bySeverity:  Object.fromEntries(bySeverity.map((r) => [r.severity, Number(r.cnt)])),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch AML stats" });
  }
});

export default router;
