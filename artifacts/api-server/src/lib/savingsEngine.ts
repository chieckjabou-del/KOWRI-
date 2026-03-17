import { db } from "@workspace/db";
import { savingsPlansTable, walletsTable, creditScoresTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { generateId } from "./id";
import { processTransfer, processDeposit } from "./walletService";
import { eventBus } from "./eventBus";
import { audit } from "./auditLogger";

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
  earlyBreakPenalty?: number;
}): Promise<typeof savingsPlansTable.$inferSelect> {
  const annualRate = await getRateForUser(params.userId);

  const tx = await processTransfer({
    fromWalletId: params.walletId,
    toWalletId:   params.savingsWalletId,
    amount:       params.amount,
    currency:     params.currency,
    description:  `Savings plan lock – ${params.name}`,
    skipFraudCheck: true,
  });

  const maturityDate = new Date();
  maturityDate.setDate(maturityDate.getDate() + params.termDays);

  const [plan] = await db.insert(savingsPlansTable).values({
    id:                generateId(),
    userId:            params.userId,
    walletId:          params.savingsWalletId,
    name:              params.name,
    lockedAmount:      String(params.amount),
    currency:          params.currency,
    interestRate:      String(annualRate),
    termDays:          params.termDays,
    maturityDate,
    earlyBreakPenalty: String(params.earlyBreakPenalty ?? 10),
  }).returning();

  await audit({ action: "savings.plan.created", entity: "savings_plan", entityId: plan.id,
    metadata: { userId: params.userId, amount: params.amount, termDays: params.termDays, annualRate } });
  await eventBus.publish("savings.plan.created", { planId: plan.id, userId: params.userId, amount: params.amount });
  return plan;
}

export async function accrueYield(planId: string): Promise<number> {
  const [plan] = await db.select().from(savingsPlansTable).where(eq(savingsPlansTable.id, planId));
  if (!plan) throw new Error(`Savings plan ${planId} not found`);
  if (plan.status !== "active") return 0;

  const annualRate  = Number(plan.interestRate) / 100;
  const dailyRate   = annualRate / 365;
  const yieldAmount = Number(plan.lockedAmount) * dailyRate;

  if (yieldAmount <= 0) return 0;

  await processDeposit({
    walletId:    plan.walletId,
    amount:      yieldAmount,
    currency:    plan.currency,
    reference:   `YIELD-${planId}-${Date.now()}`,
    description: `Daily yield accrual – ${plan.name}`,
  });

  await db.update(savingsPlansTable).set({
    accruedYield: sql`${savingsPlansTable.accruedYield} + ${String(yieldAmount)}`,
    updatedAt: new Date(),
  }).where(eq(savingsPlansTable.id, planId));

  await eventBus.publish("savings.yield.accrued", { planId, yieldAmount, currency: plan.currency });
  return yieldAmount;
}

export async function matureSavingsPlan(planId: string, targetWalletId: string): Promise<{
  principal: number; yield: number; total: number; penalty: number;
}> {
  const locked = await db.update(savingsPlansTable)
    .set({ status: "maturing", updatedAt: new Date() })
    .where(and(eq(savingsPlansTable.id, planId), eq(savingsPlansTable.status, "active")))
    .returning({ id: savingsPlansTable.id, lockedAmount: savingsPlansTable.lockedAmount,
      accruedYield: savingsPlansTable.accruedYield, earlyBreakPenalty: savingsPlansTable.earlyBreakPenalty,
      maturityDate: savingsPlansTable.maturityDate, walletId: savingsPlansTable.walletId,
      currency: savingsPlansTable.currency, name: savingsPlansTable.name });

  if (!locked.length) throw new Error("Plan is not active or concurrent maturation in progress");
  const plan = locked[0];

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
  const total     = principal + finalYield;

  await processTransfer({
    fromWalletId: plan.walletId,
    toWalletId:   targetWalletId,
    amount:       total,
    currency:     plan.currency,
    description:  isEarlyBreak
      ? `Early savings break – ${plan.name} (penalty: ${penalty.toFixed(2)} ${plan.currency})`
      : `Savings maturity – ${plan.name}`,
    skipFraudCheck: true,
  });

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
