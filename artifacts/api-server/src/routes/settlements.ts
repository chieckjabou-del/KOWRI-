import { Router } from "express";
import { createSettlement, processSettlement, getSettlements } from "../lib/settlementService";
import { db } from "@workspace/db";
import { settlementsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { routeParamString } from "../lib/routeParams";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const { settlements, total } = await getSettlements(limit, offset);
    return res.json({ settlements, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (err) { return next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const { partner, amount, currency, metadata } = req.body;
    if (!partner || !amount || !currency) {
      return res.status(400).json({ error: true, message: "partner, amount, and currency are required" });
    }
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: true, message: "amount must be a positive number" });
    }
    const id = await createSettlement(partner, numAmount, currency, metadata);
    const [settlement] = await db.select().from(settlementsTable).where(eq(settlementsTable.id, id));
    return res.status(201).json({ ...settlement, amount: Number(settlement.amount) });
  } catch (err) { return next(err); }
});

router.post("/:id/process", async (req, res, next) => {
  try {
    const id = routeParamString(req, "id")!;
    await processSettlement(id);
    const [settlement] = await db.select().from(settlementsTable).where(eq(settlementsTable.id, id));
    return res.json({ ...settlement, amount: Number(settlement.amount) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (msg.includes("not found")) { res.status(404).json({ error: true, message: msg }); return; }
    if (msg.includes("is ")) { res.status(409).json({ error: true, message: msg }); return; }
    return next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [settlement] = await db.select().from(settlementsTable).where(eq(settlementsTable.id, req.params.id));
    if (!settlement) { res.status(404).json({ error: true, message: "Settlement not found" }); return; }
    return res.json({ ...settlement, amount: Number(settlement.amount) });
  } catch (err) { return next(err); }
});

export default router;
