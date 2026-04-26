import { Router } from "express";
import { db } from "@workspace/db";
import { savingsPlansTable, walletsTable } from "@workspace/db";
import { eq, and, desc, count } from "drizzle-orm";
import { generateId } from "../lib/id";
import {
  createSavingsPlan, accrueYield, matureSavingsPlan,
  getSavingsPlansByUser, getRateForUser,
} from "../lib/savingsEngine";
import { requireAuth } from "../lib/productAuth";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";
import { routeParamString } from "../lib/routeParams";
import {
  VALID_CURRENCIES,
  parsePositiveAmount,
  parsePositiveInteger,
} from "../middleware/validate";

const router = Router();

router.use(async (req, res, next) => {
  const auth = await requireAuth(req.headers.authorization);
  if (!auth) {
    return res.status(401).json({ error: true, message: "Unauthorized. Provide a valid Bearer token." });
  }
  return next();
});

router.get("/plans", async (req, res, next) => {
  try {
    const { userId, status } = req.query;
    if (!userId) return res.status(400).json({ error: true, message: "userId required" });

    const rows = await db.select().from(savingsPlansTable)
      .where(and(
        eq(savingsPlansTable.userId, userId as string),
        status ? eq(savingsPlansTable.status, status as any) : undefined,
      ))
      .orderBy(desc(savingsPlansTable.createdAt));

    const now = new Date();
    return res.json({
      plans: rows.map(p => ({
        ...p,
        lockedAmount:      Number(p.lockedAmount),
        interestRate:      Number(p.interestRate),
        accruedYield:      Number(p.accruedYield),
        earlyBreakPenalty: Number(p.earlyBreakPenalty),
        isMatured:         now >= new Date(p.maturityDate),
        daysRemaining:     Math.max(0, Math.ceil((new Date(p.maturityDate).getTime() - now.getTime()) / 86400000)),
      })),
    });
  } catch (err) { return next(err); }
});

router.post("/plans", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { userId, walletId, name, amount, currency = "XOF", termDays, earlyBreakPenalty } = req.body;
    if (!userId || !walletId || !name || amount == null || termDays == null) {
      return res.status(400).json({ error: true, message: "userId, walletId, name, amount, termDays required" });
    }
    const parsedAmount = parsePositiveAmount(amount);
    const parsedTermDays = parsePositiveInteger(termDays, { min: 1, max: 3650 });
    const parsedEarlyBreakPenalty =
      earlyBreakPenalty == null ? undefined : parsePositiveAmount(earlyBreakPenalty);
    if (parsedAmount === null) {
      return res.status(400).json({ error: true, message: "amount must be a positive number" });
    }
    if (parsedTermDays === null) {
      return res.status(400).json({ error: true, message: "termDays must be an integer between 1 and 3650" });
    }
    if (!VALID_CURRENCIES.has(String(currency))) {
      return res.status(400).json({ error: true, message: `currency must be one of: ${[...VALID_CURRENCIES].join(", ")}` });
    }
    if (earlyBreakPenalty != null && parsedEarlyBreakPenalty === null) {
      return res.status(400).json({ error: true, message: "earlyBreakPenalty must be a positive number when provided" });
    }

    const savingsWalletId = generateId();
    await db.insert(walletsTable).values({
      id: savingsWalletId, userId, currency,
      balance: "0", availableBalance: "0",
      status: "active", walletType: "savings",
      createdAt: new Date(), updatedAt: new Date(),
    });

    const plan = await createSavingsPlan({
      userId, walletId, savingsWalletId,
      name, amount: parsedAmount, currency,
      termDays: parsedTermDays,
      earlyBreakPenalty: parsedEarlyBreakPenalty ?? undefined,
    });

    const body = {
      ...plan,
      lockedAmount:      Number(plan.lockedAmount),
      interestRate:      Number(plan.interestRate),
      accruedYield:      Number(plan.accruedYield),
      earlyBreakPenalty: Number(plan.earlyBreakPenalty),
      isMatured:         false,
      daysRemaining:     parsedTermDays,
    };
    await req.saveIdempotentResponse?.(body, 201);
    return res.status(201).json(body);
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/plans/:planId", async (req, res, next) => {
  try {
    const [plan] = await db.select().from(savingsPlansTable)
      .where(eq(savingsPlansTable.id, req.params.planId));
    if (!plan) return res.status(404).json({ error: true, message: "Savings plan not found" });

    const now = new Date();
    return res.json({
      ...plan,
      lockedAmount:      Number(plan.lockedAmount),
      interestRate:      Number(plan.interestRate),
      accruedYield:      Number(plan.accruedYield),
      earlyBreakPenalty: Number(plan.earlyBreakPenalty),
      isMatured:         now >= new Date(plan.maturityDate),
      daysRemaining:     Math.max(0, Math.ceil((new Date(plan.maturityDate).getTime() - now.getTime()) / 86400000)),
    });
  } catch (err) { return next(err); }
});

router.post("/plans/:planId/accrue", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const planId = routeParamString(req, "planId")!;
    const yieldAmount = await accrueYield(planId);
    const body = { success: true, yieldAmount, message: `Accrued ${yieldAmount.toFixed(4)} yield` };
    await req.saveIdempotentResponse?.(body, 200);
    return res.json(body);
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.post("/plans/:planId/break", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { targetWalletId } = req.body;
    if (!targetWalletId) {
      return res.status(400).json({ error: true, message: "targetWalletId required" });
    }
    const planId = routeParamString(req, "planId")!;
    const result = await matureSavingsPlan(planId, targetWalletId);
    const body = {
      success: true,
      ...result,
      isEarlyBreak: result.penalty > 0,
      message: result.penalty > 0
        ? `Early break executed. Penalty: ${result.penalty.toFixed(2)}`
        : "Plan matured successfully",
    };
    await req.saveIdempotentResponse?.(body, 200);
    return res.json(body);
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/rate", async (req, res, next) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: true, message: "userId required" });

    const rate = await getRateForUser(userId as string);
    const tierRates = { bronze: 6, silver: 8, gold: 10, platinum: 12 };

    return res.json({
      userId,
      annualRate: rate,
      dailyRate:  Number((rate / 365).toFixed(6)),
      tierRates,
      message: `Your current savings rate is ${rate}% per annum`,
    });
  } catch (err) { return next(err); }
});

router.get("/summary/:userId", async (req, res, next) => {
  try {
    const plans = await getSavingsPlansByUser(req.params.userId);
    const active  = plans.filter(p => p.status === "active");
    const matured = plans.filter(p => p.status === "matured");

    const totalLocked = active.reduce((s, p) => s + p.lockedAmount, 0);
    const totalYield  = active.reduce((s, p) => s + p.accruedYield, 0);

    return res.json({
      userId: req.params.userId,
      totalPlans:   plans.length,
      activePlans:  active.length,
      maturedPlans: matured.length,
      totalLocked,
      totalYield,
      plans,
    });
  } catch (err) { return next(err); }
});

export default router;
