import { Router } from "express";
import { db } from "@workspace/db";
import {
  remittanceCorridorsTable, beneficiariesTable, recurringTransfersTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import {
  listCorridors, addBeneficiary, getBeneficiaries,
  sendRemittance, createRecurringTransfer, runDueRecurringTransfers,
  seedCorridors,
} from "../lib/diasporaService";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";
import { authenticate, requirePermission, walletBelongsToUser } from "../middleware/auth";
import { routeParamString } from "../lib/routeParams";

const router = Router();

router.post("/recurring/run", requirePermission("ledger.write"), async (req, res, next) => {
  try {
    const result = await runDueRecurringTransfers();
    return res.json({ success: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.use(authenticate());

router.get("/corridors", async (req, res, next) => {
  try {
    await seedCorridors();
    const { fromCountry, toCountry } = req.query;
    const corridors = await listCorridors(
      fromCountry as string | undefined,
      toCountry   as string | undefined,
    );
    return res.json({ corridors, count: corridors.length });
  } catch (err) { return next(err); }
});

router.get("/corridors/:corridorId", async (req, res, next) => {
  try {
    const corridorId = routeParamString(req, "corridorId")!;
    const [corridor] = await db.select().from(remittanceCorridorsTable)
      .where(eq(remittanceCorridorsTable.id, corridorId));
    if (!corridor) return res.status(404).json({ error: true, message: "Corridor not found" });
    return res.json({
      ...corridor,
      flatFee:    Number(corridor.flatFee),
      percentFee: Number(corridor.percentFee),
      maxAmount:  Number(corridor.maxAmount),
      minAmount:  Number(corridor.minAmount),
    });
  } catch (err) { return next(err); }
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

    return res.json({
      amount: Number(amount),
      fromCurrency,
      toCurrency,
      quotes,
      bestQuote: quotes[0] ?? null,
    });
  } catch (err) { return next(err); }
});

router.get("/beneficiaries", async (req, res, next) => {
  try {
    const beneficiaries = await getBeneficiaries(req.auth!.userId);
    return res.json({ beneficiaries, count: beneficiaries.length });
  } catch (err) { return next(err); }
});

router.post("/beneficiaries", async (req, res, next) => {
  try {
    const { name, phone, walletId, relationship = "other", country, currency = "XOF" } = req.body;
    if (!name || !country) {
      return res.status(400).json({ error: true, message: "name, country required" });
    }
    if (!phone && !walletId) {
      return res.status(400).json({ error: true, message: "Either phone or walletId required" });
    }
    const bene = await addBeneficiary({ userId: req.auth!.userId, name, phone, walletId, relationship, country, currency });
    return res.status(201).json(bene);
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.delete("/beneficiaries/:beneficiaryId", async (req, res, next) => {
  try {
    const beneficiaryId = routeParamString(req, "beneficiaryId")!;
    const updated = await db.update(beneficiariesTable)
      .set({ active: false })
      .where(and(eq(beneficiariesTable.id, beneficiaryId), eq(beneficiariesTable.userId, req.auth!.userId)))
      .returning({ id: beneficiariesTable.id });
    if (!updated.length) return res.status(404).json({ error: true, message: "Beneficiary not found" });
    return res.json({ success: true });
  } catch (err) { return next(err); }
});

router.post("/send", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { fromWalletId, beneficiaryId, amount, fromCurrency, toCurrency, description } = req.body;
    if (!fromWalletId || !beneficiaryId || !amount || !fromCurrency || !toCurrency) {
      return res.status(400).json({
        error: true,
        message: "fromWalletId, beneficiaryId, amount, fromCurrency, toCurrency required",
      });
    }
    if (!(await walletBelongsToUser(String(fromWalletId), req.auth!.userId))) {
      return res.status(403).json({ error: true, message: "You do not own the source wallet" });
    }
    const result = await sendRemittance({
      fromWalletId, senderUserId: req.auth!.userId, beneficiaryId,
      amount: Number(amount), fromCurrency, toCurrency, description,
      idempotencyKey: req.idempotencyKey,
    });
    return res.status(201).json({ success: true, ...result });
  } catch (err: any) {
    // Scope and kill-switch refusals keep their 503 semantics.
    if (err?.name === "ModuleDisabledError" || err?.name === "KillSwitchError") return next(err);
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/recurring", async (req, res, next) => {
  try {
    const rows = await db.select().from(recurringTransfersTable)
      .where(eq(recurringTransfersTable.userId, req.auth!.userId))
      .orderBy(desc(recurringTransfersTable.createdAt));

    return res.json({
      recurring: rows.map(r => ({ ...r, amount: Number(r.amount) })),
      count: rows.length,
    });
  } catch (err) { return next(err); }
});

router.post("/recurring", async (req, res, next) => {
  try {
    const {
      fromWalletId, beneficiaryId, toWalletId,
      amount, currency = "XOF", frequency = "monthly", description, maxRuns,
    } = req.body;
    const userId = req.auth!.userId;

    if (!fromWalletId || !beneficiaryId || !amount) {
      return res.status(400).json({ error: true, message: "fromWalletId, beneficiaryId, amount required" });
    }
    if (!(await walletBelongsToUser(String(fromWalletId), userId))) {
      return res.status(403).json({ error: true, message: "You do not own the source wallet" });
    }
    const [bene] = await db.select({ id: beneficiariesTable.id }).from(beneficiariesTable)
      .where(and(eq(beneficiariesTable.id, beneficiaryId), eq(beneficiariesTable.userId, userId)));
    if (!bene) return res.status(404).json({ error: true, message: "Beneficiary not found" });

    const recurring = await createRecurringTransfer({
      userId, fromWalletId, beneficiaryId, toWalletId,
      amount: Number(amount), currency, frequency, description,
      maxRuns: maxRuns ? Number(maxRuns) : undefined,
    });

    return res.status(201).json({ ...recurring, amount: Number(recurring.amount) });
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

async function setRecurringStatus(req: any, res: any, next: any, status: "paused" | "active" | "cancelled") {
  try {
    const recurringId = routeParamString(req, "recurringId")!;
    const updated = await db.update(recurringTransfersTable)
      .set({ status })
      .where(and(eq(recurringTransfersTable.id, recurringId), eq(recurringTransfersTable.userId, req.auth!.userId)))
      .returning({ id: recurringTransfersTable.id });
    if (!updated.length) return res.status(404).json({ error: true, message: "Recurring transfer not found" });
    return res.json({ success: true, status });
  } catch (err) { return next(err); }
}

router.patch("/recurring/:recurringId/pause", (req, res, next) => setRecurringStatus(req, res, next, "paused"));
router.patch("/recurring/:recurringId/resume", (req, res, next) => setRecurringStatus(req, res, next, "active"));
router.delete("/recurring/:recurringId", (req, res, next) => setRecurringStatus(req, res, next, "cancelled"));

export default router;
