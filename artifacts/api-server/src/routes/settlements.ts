import { Router } from "express";
import { createSettlement, processSettlement, getSettlements } from "../lib/settlementService";
import { db } from "@workspace/db";
import { settlementsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const { settlements, total } = await getSettlements(limit, offset);
    res.json({ settlements, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const { partner, amount, currency, metadata } = req.body;
    if (!partner || !amount || !currency) {
      res.status(400).json({ error: true, message: "partner, amount, and currency are required" });
      return;
    }
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      res.status(400).json({ error: true, message: "amount must be a positive number" });
      return;
    }
    const id = await createSettlement(partner, numAmount, currency, metadata);
    const [settlement] = await db.select().from(settlementsTable).where(eq(settlementsTable.id, id));
    res.status(201).json({ ...settlement, amount: Number(settlement.amount) });
  } catch (err) { next(err); }
});

router.post("/:id/process", async (req, res, next) => {
  try {
    await processSettlement(req.params.id);
    const [settlement] = await db.select().from(settlementsTable).where(eq(settlementsTable.id, req.params.id));
    res.json({ ...settlement, amount: Number(settlement.amount) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (msg.includes("not found")) { res.status(404).json({ error: true, message: msg }); return; }
    if (msg.includes("is ")) { res.status(409).json({ error: true, message: msg }); return; }
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [settlement] = await db.select().from(settlementsTable).where(eq(settlementsTable.id, req.params.id));
    if (!settlement) { res.status(404).json({ error: true, message: "Settlement not found" }); return; }
    res.json({ ...settlement, amount: Number(settlement.amount) });
  } catch (err) { next(err); }
});

export default router;
