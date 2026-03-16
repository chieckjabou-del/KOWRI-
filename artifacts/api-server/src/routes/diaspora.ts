import { Router } from "express";
import { db } from "@workspace/db";
import {
  remittanceCorridorsTable, beneficiariesTable, recurringTransfersTable,
} from "@workspace/db";
import { eq, and, desc, count } from "drizzle-orm";
import {
  listCorridors, addBeneficiary, getBeneficiaries,
  sendRemittance, createRecurringTransfer, runDueRecurringTransfers,
  seedCorridors,
} from "../lib/diasporaService";

const router = Router();

router.get("/corridors", async (req, res, next) => {
  try {
    await seedCorridors();
    const { fromCountry, toCountry } = req.query;
    const corridors = await listCorridors(
      fromCountry as string | undefined,
      toCountry   as string | undefined,
    );
    res.json({ corridors, count: corridors.length });
  } catch (err) { next(err); }
});

router.get("/corridors/:corridorId", async (req, res, next) => {
  try {
    const [corridor] = await db.select().from(remittanceCorridorsTable)
      .where(eq(remittanceCorridorsTable.id, req.params.corridorId));
    if (!corridor) return res.status(404).json({ error: true, message: "Corridor not found" });
    res.json({
      ...corridor,
      flatFee:    Number(corridor.flatFee),
      percentFee: Number(corridor.percentFee),
      maxAmount:  Number(corridor.maxAmount),
      minAmount:  Number(corridor.minAmount),
    });
  } catch (err) { next(err); }
});

router.post("/quote", async (req, res, next) => {
  try {
    await seedCorridors();
    const { amount, fromCurrency, toCurrency } = req.body;
    if (!amount || !fromCurrency || !toCurrency) {
      return res.status(400).json({ error: true, message: "amount, fromCurrency, toCurrency required" });
    }

    const corridors = await db.select().from(remittanceCorridorsTable)
      .where(and(
        eq(remittanceCorridorsTable.fromCurrency, fromCurrency),
        eq(remittanceCorridorsTable.toCurrency,   toCurrency),
        eq(remittanceCorridorsTable.active,        true),
      ));

    const quotes = corridors.map(c => {
      const flatFee   = Number(c.flatFee);
      const pctFee    = Number(c.percentFee);
      const totalFee  = flatFee + (Number(amount) * pctFee / 100);
      return {
        corridorId:     c.id,
        processorId:    c.processorId,
        fromCurrency,
        toCurrency,
        sendAmount:     Number(amount),
        fee:            totalFee,
        totalDebit:     Number(amount) + totalFee,
        estimatedMins:  c.estimatedMins,
      };
    });

    quotes.sort((a, b) => a.fee - b.fee);

    res.json({
      amount: Number(amount),
      fromCurrency,
      toCurrency,
      quotes,
      bestQuote: quotes[0] ?? null,
    });
  } catch (err) { next(err); }
});

router.get("/beneficiaries", async (req, res, next) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: true, message: "userId required" });
    const beneficiaries = await getBeneficiaries(userId as string);
    res.json({ beneficiaries, count: beneficiaries.length });
  } catch (err) { next(err); }
});

router.post("/beneficiaries", async (req, res, next) => {
  try {
    const { userId, name, phone, walletId, relationship = "other", country, currency = "XOF" } = req.body;
    if (!userId || !name || !country) {
      return res.status(400).json({ error: true, message: "userId, name, country required" });
    }
    if (!phone && !walletId) {
      return res.status(400).json({ error: true, message: "Either phone or walletId required" });
    }
    const bene = await addBeneficiary({ userId, name, phone, walletId, relationship, country, currency });
    res.status(201).json(bene);
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

router.delete("/beneficiaries/:beneficiaryId", async (req, res, next) => {
  try {
    await db.update(beneficiariesTable)
      .set({ active: false })
      .where(eq(beneficiariesTable.id, req.params.beneficiaryId));
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post("/send", async (req, res, next) => {
  try {
    const { fromWalletId, senderUserId, beneficiaryId, amount, fromCurrency, toCurrency, description } = req.body;
    if (!fromWalletId || !senderUserId || !beneficiaryId || !amount || !fromCurrency || !toCurrency) {
      return res.status(400).json({
        error: true,
        message: "fromWalletId, senderUserId, beneficiaryId, amount, fromCurrency, toCurrency required",
      });
    }
    const result = await sendRemittance({
      fromWalletId, senderUserId, beneficiaryId,
      amount: Number(amount), fromCurrency, toCurrency, description,
    });
    res.status(201).json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/recurring", async (req, res, next) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: true, message: "userId required" });

    const rows = await db.select().from(recurringTransfersTable)
      .where(eq(recurringTransfersTable.userId, userId as string))
      .orderBy(desc(recurringTransfersTable.createdAt));

    res.json({
      recurring: rows.map(r => ({ ...r, amount: Number(r.amount) })),
      count: rows.length,
    });
  } catch (err) { next(err); }
});

router.post("/recurring", async (req, res, next) => {
  try {
    const {
      userId, fromWalletId, beneficiaryId, toWalletId,
      amount, currency = "XOF", frequency = "monthly", description, maxRuns,
    } = req.body;

    if (!userId || !fromWalletId || !beneficiaryId || !amount) {
      return res.status(400).json({ error: true, message: "userId, fromWalletId, beneficiaryId, amount required" });
    }

    const recurring = await createRecurringTransfer({
      userId, fromWalletId, beneficiaryId, toWalletId,
      amount: Number(amount), currency, frequency, description,
      maxRuns: maxRuns ? Number(maxRuns) : undefined,
    });

    res.status(201).json({ ...recurring, amount: Number(recurring.amount) });
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

router.patch("/recurring/:recurringId/pause", async (req, res, next) => {
  try {
    await db.update(recurringTransfersTable)
      .set({ status: "paused" })
      .where(eq(recurringTransfersTable.id, req.params.recurringId));
    res.json({ success: true, status: "paused" });
  } catch (err) { next(err); }
});

router.patch("/recurring/:recurringId/resume", async (req, res, next) => {
  try {
    await db.update(recurringTransfersTable)
      .set({ status: "active" })
      .where(eq(recurringTransfersTable.id, req.params.recurringId));
    res.json({ success: true, status: "active" });
  } catch (err) { next(err); }
});

router.delete("/recurring/:recurringId", async (req, res, next) => {
  try {
    await db.update(recurringTransfersTable)
      .set({ status: "cancelled" })
      .where(eq(recurringTransfersTable.id, req.params.recurringId));
    res.json({ success: true, status: "cancelled" });
  } catch (err) { next(err); }
});

router.post("/recurring/run", async (req, res, next) => {
  try {
    const result = await runDueRecurringTransfers();
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

export default router;
