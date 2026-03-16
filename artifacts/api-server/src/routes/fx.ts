import { Router } from "express";
import { getAllRates, convertAmount, upsertRate, getRate, FXNotFoundError } from "../lib/fxEngine";
import { generateId } from "../lib/id";
import { db } from "@workspace/db";
import { fxRateHistoryTable, exchangeRatesTable } from "@workspace/db";
import { eq, and, desc, asc } from "drizzle-orm";
import { messageQueue, MESSAGE_TOPICS } from "../lib/messageQueue";

const router = Router();

router.get("/rates", async (_req, res, next) => {
  try {
    const rates = await getAllRates();
    res.json({ rates, count: rates.length });
  } catch (err) { next(err); }
});

router.get("/rates/:from/:to", async (req, res, next) => {
  try {
    const { from, to } = req.params;
    const rate = await getRate(from.toUpperCase(), to.toUpperCase());
    res.json({ baseCurrency: from.toUpperCase(), targetCurrency: to.toUpperCase(), rate });
  } catch (err) {
    if (err instanceof FXNotFoundError) {
      res.status(404).json({ error: true, message: err.message });
      return;
    }
    next(err);
  }
});

router.post("/convert", async (req, res, next) => {
  try {
    const { amount, from, to } = req.body;
    if (!amount || !from || !to) {
      res.status(400).json({ error: true, message: "amount, from, and to are required" });
      return;
    }
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      res.status(400).json({ error: true, message: "amount must be a positive number" });
      return;
    }
    const { convertedAmount, rate } = await convertAmount(numAmount, from.toUpperCase(), to.toUpperCase());
    res.json({
      originalAmount: numAmount,
      originalCurrency: from.toUpperCase(),
      convertedAmount,
      targetCurrency: to.toUpperCase(),
      rate,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof FXNotFoundError) {
      res.status(404).json({ error: true, message: err.message });
      return;
    }
    next(err);
  }
});

router.put("/rates", async (req, res, next) => {
  try {
    const { base_currency, target_currency, rate, source = "manual" } = req.body;
    if (!base_currency || !target_currency || !rate) {
      res.status(400).json({ error: true, message: "base_currency, target_currency, and rate are required" });
      return;
    }
    const numRate = Number(rate);
    if (isNaN(numRate) || numRate <= 0) {
      res.status(400).json({ error: true, message: "rate must be a positive number" });
      return;
    }
    const from = base_currency.toUpperCase();
    const to   = target_currency.toUpperCase();
    const id   = `fx-${from.toLowerCase()}-${to.toLowerCase()}`;
    await upsertRate(id, from, to, numRate);
    await db.insert(fxRateHistoryTable).values({
      id:             generateId(),
      baseCurrency:   from,
      targetCurrency: to,
      rate:           String(numRate),
      source,
    });
    await messageQueue.produce(MESSAGE_TOPICS.FX_RATES, {
      event: "rate.updated", from, to, rate: numRate, source,
    });
    res.json({ baseCurrency: from, targetCurrency: to, rate: numRate, updated: true, source });
  } catch (err) { next(err); }
});

router.get("/rates/history/:from/:to", async (req, res, next) => {
  try {
    const from  = req.params.from.toUpperCase();
    const to    = req.params.to.toUpperCase();
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const rows  = await db.select()
      .from(fxRateHistoryTable)
      .where(and(eq(fxRateHistoryTable.baseCurrency, from), eq(fxRateHistoryTable.targetCurrency, to)))
      .orderBy(desc(fxRateHistoryTable.recordedAt))
      .limit(limit);
    res.json({ baseCurrency: from, targetCurrency: to, history: rows, count: rows.length });
  } catch (err) { next(err); }
});

router.post("/rates/snapshot", async (req, res, next) => {
  try {
    const rates = await getAllRates();
    const entries = rates.map((r) => ({
      id:             generateId(),
      baseCurrency:   r.baseCurrency,
      targetCurrency: r.targetCurrency,
      rate:           r.rate,
      source:         "scheduled_snapshot",
    }));
    if (entries.length > 0) {
      await db.insert(fxRateHistoryTable).values(entries);
    }
    res.json({ snapshotted: entries.length, timestamp: new Date().toISOString() });
  } catch (err) { next(err); }
});

export default router;
