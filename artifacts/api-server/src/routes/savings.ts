import { Router } from "express";
import { db } from "@workspace/db";
import { savingsPlansTable, walletsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { generateId } from "../lib/id";
import {
  createSavingsPlan, accrueYield, matureSavingsPlan,
  getSavingsPlansByUser, getRateForUser,
} from "../lib/savingsEngine";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";
import { routeParamString } from "../lib/routeParams";
import { authenticate, isAdminRequest, requirePermission, walletBelongsToUser } from "../middleware/auth";

const router = Router();

router.use(authenticate());

function serializePlan(p: typeof savingsPlansTable.$inferSelect) {
  const now = new Date();
  return {
    ...p,
    lockedAmount:      Number(p.lockedAmount),
    interestRate:      Number(p.interestRate),
    accruedYield:      Number(p.accruedYield),
    earlyBreakPenalty: Number(p.earlyBreakPenalty),
    isMatured:         now >= new Date(p.maturityDate),
    daysRemaining:     Math.max(0, Math.ceil((new Date(p.maturityDate).getTime() - now.getTime()) / 86400000)),
  };
}

router.get("/plans", async (req, res, next) => {
  try {
    const { status } = req.query;
    const requested = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const userId = isAdminRequest(req) && requested ? requested : req.auth!.userId;

    const rows = await db.select().from(savingsPlansTable)
      .where(and(
        eq(savingsPlansTable.userId, userId),
        status ? eq(savingsPlansTable.status, status as any) : undefined,
      ))
      .orderBy(desc(savingsPlansTable.createdAt));

    return res.json({ plans: rows.map(serializePlan) });
  } catch (err) { return next(err); }
});

router.post("/plans", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { walletId, name, amount, currency = "XOF", termDays, earlyBreakPenalty } = req.body;
    const userId = req.auth!.userId;
    if (!walletId || !name || !amount || !termDays) {
      return res.status(400).json({ error: true, message: "walletId, name, amount, termDays required" });
    }
    if (!(await walletBelongsToUser(String(walletId), userId))) {
      return res.status(403).json({ error: true, message: "You do not own this wallet" });
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
      name, amount: Number(amount), currency,
      termDays: Number(termDays),
      earlyBreakPenalty: earlyBreakPenalty ? Number(earlyBreakPenalty) : undefined,
    });

    return res.status(201).json(serializePlan(plan));
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/plans/:planId", async (req, res, next) => {
  try {
    const planId = routeParamString(req, "planId")!;
    const [plan] = await db.select().from(savingsPlansTable)
      .where(eq(savingsPlansTable.id, planId));
    if (!plan || (!isAdminRequest(req) && plan.userId !== req.auth!.userId)) {
      return res.status(404).json({ error: true, message: "Savings plan not found" });
    }
    return res.json(serializePlan(plan));
  } catch (err) { return next(err); }
});

// Yield accrual is a scheduled platform operation, not a user action.
router.post("/plans/:planId/accrue", requirePermission("ledger.write"), requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const planId = routeParamString(req, "planId")!;
    const yieldAmount = await accrueYield(planId);
    return res.json({ success: true, yieldAmount, message: `Accrued ${yieldAmount.toFixed(4)} yield` });
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
    const result = await matureSavingsPlan(planId, String(targetWalletId), req.auth!.userId);
    return res.json({
      success: true,
      ...result,
      isEarlyBreak: result.penalty > 0,
      message: result.penalty > 0
        ? `Early break executed. Penalty: ${result.penalty.toFixed(2)}`
        : "Plan matured successfully",
    });
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/rate", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const rate = await getRateForUser(userId);
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
    const userId = routeParamString(req, "userId")!;
    if (!isAdminRequest(req) && userId !== req.auth!.userId) {
      return res.status(403).json({ error: true, message: "Forbidden" });
    }
    const plans = await getSavingsPlansByUser(userId);
    const active  = plans.filter(p => p.status === "active");
    const matured = plans.filter(p => p.status === "matured");

    const totalLocked = active.reduce((s, p) => s + p.lockedAmount, 0);
    const totalYield  = active.reduce((s, p) => s + p.accruedYield, 0);

    return res.json({
      userId,
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
