import { db } from "@workspace/db";
import { savingsPlansTable, walletsTable, creditScoresTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { generateId } from "./id";
import { processTransfer, processDeposit, isDuplicateIdempotencyKey } from "./walletService";
import { eventBus } from "./eventBus";
import { audit } from "./auditLogger";
import { assertModuleEnabled } from "./launchScope";

const RATE_BY_TIER: Record<string, number> = {
  bronze:   6,
  silver:   8,
  gold:     10,
  platinum: 12,
};

export async function getRateForUser(userId: string): Promise<number> {
  const [score] = await db.select().from(creditScoresTable).where(eq(creditScoresTable.userId, userId));
  const tier = score?.tier ?? "bronze";
  return RATE_BY_TIER[tier] ?? 6;
}

export async function createSavingsPlan(params: {
  userId: string; walletId: string; savingsWalletId: string;
  name: string; amount: number; currency: string; termDays: number;
  earlyBreakPenalty?: number; idempotencyKey?: string;
}): Promise<typeof savingsPlansTable.$inferSelect> {
  assertModuleEnabled("savings");
  const annualRate = await getRateForUser(params.userId);

  const maturityDate = new Date();
  maturityDate.setDate(maturityDate.getDate() + params.termDays);
  const planId = generateId();

  // The plan row is written in the same transaction as the lock transfer, so
  // money can never sit in a savings wallet without the plan that releases it.
  await processTransfer({
    fromWalletId: params.walletId,
    toWalletId:   params.savingsWalletId,
    amount:       params.amount,
    currency:     params.currency,
    description:  `Savings plan lock – ${params.name}`,
    skipFraudCheck: true,
    idempotencyKey: params.idempotencyKey,
    attach: async (t) => {
      await t.insert(savingsPlansTable).values({
        id:                planId,
        userId:            params.userId,
        walletId:          params.savingsWalletId,
        name:              params.name,
        lockedAmount:      String(params.amount),
        currency:          params.currency,
        interestRate:      String(annualRate),
        termDays:          params.termDays,
        maturityDate,
        earlyBreakPenalty: String(params.earlyBreakPenalty ?? 10),
      });
    },
  });

  const [plan] = await db.select().from(savingsPlansTable).where(eq(savingsPlansTable.id, planId));

  await audit({ action: "savings.plan.created", entity: "savings_plan", entityId: plan.id,
    metadata: { userId: params.userId, amount: params.amount, termDays: params.termDays, annualRate } });
  await eventBus.publish("savings.plan.created", { planId: plan.id, userId: params.userId, amount: params.amount });
  return plan;
}

export async function accrueYield(planId: string): Promise<number> {
  assertModuleEnabled("savings");
  const [plan] = await db.select().from(savingsPlansTable).where(eq(savingsPlansTable.id, planId));
  if (!plan) throw new Error(`Savings plan ${planId} not found`);
  if (plan.status !== "active") return 0;

  const annualRate  = Number(plan.interestRate) / 100;
  const dailyRate   = annualRate / 365;
  const yieldAmount = Math.round(Number(plan.lockedAmount) * dailyRate * 10000) / 10000;

  if (yieldAmount <= 0) return 0;

  // One accrual per plan per calendar day, enforced by the unique idempotency key.
  const day = new Date().toISOString().slice(0, 10);
  try {
    await processDeposit({
      walletId:    plan.walletId,
      amount:      yieldAmount,
      currency:    plan.currency,
      reference:   `YIELD-${planId}-${day}`,
      description: `Daily yield accrual – ${plan.name}`,
      idempotencyKey: `savings-yield:${planId}:${day}`,
      internal: true,
      authority: { kind: "savings_yield", planId },
    });
  } catch (err) {
    if (isDuplicateIdempotencyKey(err) || (err as any)?.code === "23505") return 0;
    throw err;
  }

  await db.update(savingsPlansTable).set({
    accruedYield: sql`${savingsPlansTable.accruedYield} + ${String(yieldAmount)}`,
    updatedAt: new Date(),
  }).where(eq(savingsPlansTable.id, planId));

  await eventBus.publish("savings.yield.accrued", { planId, yieldAmount, currency: plan.currency });
  return yieldAmount;
}

export async function matureSavingsPlan(planId: string, targetWalletId: string, ownerId: string): Promise<{
  principal: number; yield: number; total: number; penalty: number;
}> {
  assertModuleEnabled("savings");
  const [target] = await db.select({ userId: walletsTable.userId, currency: walletsTable.currency })
    .from(walletsTable).where(eq(walletsTable.id, targetWalletId)).limit(1);
  if (!target || target.userId !== ownerId) throw new Error("Target wallet not found");

  const locked = await db.update(savingsPlansTable)
    .set({ status: "maturing", updatedAt: new Date() })
    .where(and(eq(savingsPlansTable.id, planId), eq(savingsPlansTable.userId, ownerId), eq(savingsPlansTable.status, "active")))
    .returning({ id: savingsPlansTable.id, lockedAmount: savingsPlansTable.lockedAmount,
      accruedYield: savingsPlansTable.accruedYield, earlyBreakPenalty: savingsPlansTable.earlyBreakPenalty,
      maturityDate: savingsPlansTable.maturityDate, walletId: savingsPlansTable.walletId,
      currency: savingsPlansTable.currency, name: savingsPlansTable.name });

  if (!locked.length) throw new Error("Plan is not active or concurrent maturation in progress");
  const plan = locked[0];
  if (target.currency !== plan.currency) {
    await db.update(savingsPlansTable).set({ status: "active", updatedAt: new Date() }).where(eq(savingsPlansTable.id, planId));
    throw new Error(`Target wallet must be denominated in ${plan.currency}`);
  }

  const now = new Date();
  const isEarlyBreak = now < new Date(plan.maturityDate);
  const accruedYield = Number(plan.accruedYield);

  let penalty = 0;
  let finalYield = accruedYield;
  if (isEarlyBreak) {
    penalty    = accruedYield * (Number(plan.earlyBreakPenalty) / 100);
    finalYield = accruedYield - penalty;
  }

  const principal = Number(plan.lockedAmount);
  const total     = Math.round((principal + finalYield) * 10000) / 10000;

  try {
    await processTransfer({
      fromWalletId: plan.walletId,
      toWalletId:   targetWalletId,
      amount:       total,
      currency:     plan.currency,
      description:  isEarlyBreak
        ? `Early savings break – ${plan.name} (penalty: ${penalty.toFixed(2)} ${plan.currency})`
        : `Savings maturity – ${plan.name}`,
      skipFraudCheck: true,
      skipKycCheck: true,
      idempotencyKey: `savings-mature:${planId}`,
    });
  } catch (err) {
    // Release the plan so the owner can retry instead of stranding it in "maturing".
    await db.update(savingsPlansTable).set({ status: "active", updatedAt: new Date() }).where(eq(savingsPlansTable.id, planId));
    throw err;
  }

  await db.update(savingsPlansTable).set({
    status: "matured", updatedAt: new Date(),
  }).where(eq(savingsPlansTable.id, planId));

  await audit({ action: "savings.plan.matured", entity: "savings_plan", entityId: planId,
    metadata: { principal, finalYield, penalty, isEarlyBreak, total } });
  await eventBus.publish("savings.plan.matured", { planId, principal, finalYield, penalty, total });

  return { principal, yield: finalYield, total, penalty };
}

export async function getSavingsPlansByUser(userId: string) {
  const plans = await db.select().from(savingsPlansTable)
    .where(eq(savingsPlansTable.userId, userId));
  return plans.map(p => ({
    ...p,
    lockedAmount:  Number(p.lockedAmount),
    interestRate:  Number(p.interestRate),
    accruedYield:  Number(p.accruedYield),
    earlyBreakPenalty: Number(p.earlyBreakPenalty),
    isMatured: new Date() >= new Date(p.maturityDate),
  }));
}
