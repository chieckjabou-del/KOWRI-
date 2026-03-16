import { db } from "@workspace/db";
import {
  investmentPoolsTable, poolPositionsTable,
  insurancePoolsTable, insurancePoliciesTable, insuranceClaimsTable,
  walletsTable,
} from "@workspace/db";
import { eq, and, sql, count, desc } from "drizzle-orm";
import { generateId } from "./id";
import { processTransfer, processDeposit } from "./walletService";
import { eventBus } from "./eventBus";
import { audit } from "./auditLogger";

export async function createInvestmentPool(params: {
  name: string; description?: string; poolType: string; managerId: string;
  poolWalletId: string; goalAmount: number; currency: string;
  minInvestment: number; expectedReturn: number; closingDate?: Date; maturityDate?: Date;
}): Promise<typeof investmentPoolsTable.$inferSelect> {
  const [pool] = await db.insert(investmentPoolsTable).values({
    id:           generateId(),
    name:         params.name,
    description:  params.description ?? null,
    poolType:     params.poolType,
    managerId:    params.managerId,
    walletId:     params.poolWalletId,
    goalAmount:   String(params.goalAmount),
    currency:     params.currency,
    minInvestment: String(params.minInvestment),
    expectedReturn: String(params.expectedReturn),
    closingDate:  params.closingDate ?? null,
    maturityDate: params.maturityDate ?? null,
  }).returning();

  await audit({ action: "investment.pool.created", entity: "investment_pool", entityId: pool.id,
    metadata: { managerId: params.managerId, goalAmount: params.goalAmount, currency: params.currency } });
  await eventBus.publish("investment.pool.created", { poolId: pool.id, managerId: params.managerId });
  return pool;
}

export async function investInPool(params: {
  poolId: string; userId: string; fromWalletId: string; amount: number;
}): Promise<typeof poolPositionsTable.$inferSelect> {
  const [pool] = await db.select().from(investmentPoolsTable).where(eq(investmentPoolsTable.id, params.poolId));
  if (!pool) throw new Error("Investment pool not found");
  if (pool.status !== "open") throw new Error("Pool is not accepting investments");
  if (params.amount < Number(pool.minInvestment)) {
    throw new Error(`Minimum investment is ${pool.minInvestment} ${pool.currency}`);
  }

  const tx = await processTransfer({
    fromWalletId: params.fromWalletId,
    toWalletId:   pool.walletId,
    amount:       params.amount,
    currency:     pool.currency,
    description:  `Investment in ${pool.name}`,
    skipFraudCheck: true,
  });

  const totalInvested  = Number(pool.currentAmount) + params.amount;
  const totalShares    = Number(pool.totalShares) || params.amount;
  const newShares      = Number(pool.totalShares) === 0
    ? params.amount
    : (params.amount / Number(pool.goalAmount)) * totalShares;

  await db.update(investmentPoolsTable).set({
    currentAmount: String(totalInvested),
    totalShares:   String(totalShares + newShares),
    status:        totalInvested >= Number(pool.goalAmount) ? "funded" : "open",
    updatedAt:     new Date(),
  }).where(eq(investmentPoolsTable.id, params.poolId));

  const [position] = await db.insert(poolPositionsTable).values({
    id:             generateId(),
    poolId:         params.poolId,
    userId:         params.userId,
    shares:         String(newShares.toFixed(8)),
    investedAmount: String(params.amount),
    currency:       pool.currency,
    transactionId:  tx.id,
  }).returning();

  await eventBus.publish("investment.pool.invested", {
    poolId: params.poolId, userId: params.userId, amount: params.amount, shares: newShares,
  });
  return position;
}

export async function distributePoolReturns(poolId: string, totalReturn: number): Promise<number> {
  const [pool] = await db.select().from(investmentPoolsTable).where(eq(investmentPoolsTable.id, poolId));
  if (!pool) throw new Error("Pool not found");

  const positions = await db.select().from(poolPositionsTable)
    .where(and(eq(poolPositionsTable.poolId, poolId), eq(poolPositionsTable.status, "active")));

  const totalShares = Number(pool.totalShares);
  let distributed = 0;

  for (const pos of positions) {
    const posShares = Number(pos.shares);
    const share     = totalShares > 0 ? (posShares / totalShares) * totalReturn : 0;
    if (share <= 0) continue;

    const [userWallet] = await db.select().from(walletsTable).where(eq(walletsTable.userId, pos.userId));
    if (!userWallet) continue;

    await processDeposit({
      walletId:    userWallet.id,
      amount:      share,
      currency:    pool.currency,
      reference:   `RETURN-${poolId}-${pos.userId}`,
      description: `Investment return from ${pool.name}`,
    });

    await db.update(poolPositionsTable).set({ returnAmount: String(Number(pos.returnAmount) + share) })
      .where(eq(poolPositionsTable.id, pos.id));

    distributed += share;
  }

  await db.update(investmentPoolsTable).set({ status: "matured", updatedAt: new Date() })
    .where(eq(investmentPoolsTable.id, poolId));

  await eventBus.publish("investment.pool.returns.distributed", { poolId, totalReturn, distributed, positions: positions.length });
  return distributed;
}

export async function redeemPoolPosition(positionId: string, userId: string): Promise<void> {
  const [pos] = await db.select().from(poolPositionsTable)
    .where(and(eq(poolPositionsTable.id, positionId), eq(poolPositionsTable.userId, userId)));
  if (!pos) throw new Error("Position not found");
  if (pos.status !== "active") throw new Error("Position already redeemed");

  const [pool] = await db.select().from(investmentPoolsTable).where(eq(investmentPoolsTable.id, pos.poolId));
  if (!pool) throw new Error("Pool not found");
  if (pool.status !== "matured" && pool.status !== "open") {
    throw new Error("Pool not yet matured");
  }

  const [userWallet] = await db.select().from(walletsTable).where(eq(walletsTable.userId, userId));
  if (!userWallet) throw new Error("User wallet not found");

  const redeemAmount = Number(pos.investedAmount) + Number(pos.returnAmount);

  await processTransfer({
    fromWalletId: pool.walletId,
    toWalletId:   userWallet.id,
    amount:       redeemAmount,
    currency:     pool.currency,
    description:  `Redemption from ${pool.name}`,
    skipFraudCheck: true,
  });

  await db.update(poolPositionsTable).set({
    status: "redeemed", redeemedAt: new Date(),
  }).where(eq(poolPositionsTable.id, positionId));

  await eventBus.publish("investment.pool.redeemed", { poolId: pos.poolId, userId, amount: redeemAmount });
}

export async function createInsurancePool(params: {
  name: string; description?: string; insuranceType: string; managerId: string;
  poolWalletId: string; premiumAmount: number; premiumFreq: string;
  claimLimit: number; currency: string; maxMembers: number;
}): Promise<typeof insurancePoolsTable.$inferSelect> {
  const [pool] = await db.insert(insurancePoolsTable).values({
    id:            generateId(),
    name:          params.name,
    description:   params.description ?? null,
    insuranceType: params.insuranceType,
    managerId:     params.managerId,
    walletId:      params.poolWalletId,
    premiumAmount: String(params.premiumAmount),
    premiumFreq:   params.premiumFreq,
    claimLimit:    String(params.claimLimit),
    currency:      params.currency,
    maxMembers:    params.maxMembers,
  }).returning();

  await eventBus.publish("insurance.pool.created", { poolId: pool.id, managerId: params.managerId });
  return pool;
}

export async function joinInsurancePool(poolId: string, userId: string, walletId: string): Promise<typeof insurancePoliciesTable.$inferSelect> {
  const [pool] = await db.select().from(insurancePoolsTable).where(eq(insurancePoolsTable.id, poolId));
  if (!pool) throw new Error("Insurance pool not found");
  if (pool.status !== "active") throw new Error("Pool is not active");
  if (pool.memberCount >= pool.maxMembers) throw new Error("Pool is full");

  const existing = await db.select().from(insurancePoliciesTable)
    .where(and(eq(insurancePoliciesTable.poolId, poolId), eq(insurancePoliciesTable.userId, userId)));
  if (existing[0]) throw new Error("Already a member of this pool");

  const nextPremiumAt = new Date();
  nextPremiumAt.setMonth(nextPremiumAt.getMonth() + 1);

  await processTransfer({
    fromWalletId: walletId,
    toWalletId:   pool.walletId,
    amount:       Number(pool.premiumAmount),
    currency:     pool.currency,
    description:  `Insurance premium – ${pool.name}`,
    skipFraudCheck: true,
  });

  const [policy] = await db.insert(insurancePoliciesTable).values({
    id:              generateId(),
    poolId, userId, walletId,
    premiumPaidAt:   new Date(),
    nextPremiumAt,
    totalPremiumPaid: pool.premiumAmount,
  }).returning();

  await db.update(insurancePoolsTable).set({
    memberCount: sql`${insurancePoolsTable.memberCount} + 1`,
    updatedAt: new Date(),
  }).where(eq(insurancePoolsTable.id, poolId));

  await eventBus.publish("insurance.policy.created", { poolId, userId, policyId: policy.id });
  return policy;
}

export async function fileClaim(params: {
  policyId: string; poolId: string; userId: string;
  claimAmount: number; reason: string; evidenceUrl?: string;
}): Promise<typeof insuranceClaimsTable.$inferSelect> {
  const [policy] = await db.select().from(insurancePoliciesTable)
    .where(and(eq(insurancePoliciesTable.id, params.policyId), eq(insurancePoliciesTable.userId, params.userId)));
  if (!policy) throw new Error("Policy not found");
  if (policy.status !== "active") throw new Error("Policy is not active");

  const [pool] = await db.select().from(insurancePoolsTable).where(eq(insurancePoolsTable.id, params.poolId));
  if (!pool) throw new Error("Pool not found");

  if (params.claimAmount > Number(pool.claimLimit)) {
    throw new Error(`Claim exceeds limit of ${pool.claimLimit} ${pool.currency}`);
  }

  const [claim] = await db.insert(insuranceClaimsTable).values({
    id:          generateId(),
    policyId:    params.policyId,
    poolId:      params.poolId,
    userId:      params.userId,
    claimAmount: String(params.claimAmount),
    currency:    pool.currency,
    reason:      params.reason,
    evidenceUrl: params.evidenceUrl ?? null,
  }).returning();

  await eventBus.publish("insurance.claim.filed", { claimId: claim.id, poolId: params.poolId, userId: params.userId });
  return claim;
}

export async function adjudicateClaim(claimId: string, adjudicatorId: string, approved: boolean, payoutAmount?: number, rejectionReason?: string): Promise<void> {
  const [claim] = await db.select().from(insuranceClaimsTable).where(eq(insuranceClaimsTable.id, claimId));
  if (!claim) throw new Error("Claim not found");
  if (claim.status !== "pending") throw new Error("Claim already processed");

  if (approved && payoutAmount) {
    const [pool] = await db.select().from(insurancePoolsTable).where(eq(insurancePoolsTable.id, claim.poolId));
    const [userWallet] = await db.select().from(walletsTable).where(eq(walletsTable.userId, claim.userId));

    if (pool && userWallet) {
      const tx = await processTransfer({
        fromWalletId: pool.walletId,
        toWalletId:   userWallet.id,
        amount:       payoutAmount,
        currency:     claim.currency,
        description:  `Insurance claim payout – ${claimId}`,
        skipFraudCheck: true,
      });

      await db.update(insuranceClaimsTable).set({
        status: "approved", adjudicatorId, payoutAmount: String(payoutAmount),
        transactionId: tx.id, resolvedAt: new Date(),
      }).where(eq(insuranceClaimsTable.id, claimId));

      await db.update(insurancePoliciesTable).set({
        claimsCount: sql`${insurancePoliciesTable.claimsCount} + 1`,
      }).where(eq(insurancePoliciesTable.id, claim.policyId));
    }
  } else {
    await db.update(insuranceClaimsTable).set({
      status: "rejected", adjudicatorId, rejectionReason: rejectionReason ?? "Rejected",
      resolvedAt: new Date(),
    }).where(eq(insuranceClaimsTable.id, claimId));
  }

  await eventBus.publish("insurance.claim.adjudicated", { claimId, approved, adjudicatorId });
}
