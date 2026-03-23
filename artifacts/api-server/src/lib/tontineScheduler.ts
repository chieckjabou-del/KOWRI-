import { db } from "@workspace/db";
import {
  tontinesTable, tontineMembersTable, walletsTable, transactionsTable,
  tontinePositionListingsTable, tontineBidsTable, reputationScoresTable,
  schedulerJobsTable, tontinePurchaseGoalsTable, tontineStrategyTargetsTable,
  merchantsTable, investmentPoolsTable, poolPositionsTable,
  tontineHybridCyclesTable, tontineSolidaryClaimsTable,
} from "@workspace/db";
import { eq, and, sql, asc, ne, like } from "drizzle-orm";
import { generateId } from "./id";
import { processTransfer } from "./walletService";
import { eventBus } from "./eventBus";
import { audit } from "./auditLogger";
import { randomBytes } from "crypto";

export type RotationModel = "fixed" | "random" | "auction" | "admin";

export async function runContributionCycle(tontineId: string): Promise<{
  collected: number; failed: string[]; totalCollected: number;
}> {
  const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
  if (!tontine) throw new Error(`Tontine ${tontineId} not found`);
  if (tontine.status !== "active") throw new Error(`Tontine ${tontineId} is not active`);

  const members = await db.select().from(tontineMembersTable)
    .where(eq(tontineMembersTable.tontineId, tontineId));

  const currency      = tontine.currency;
  const poolWalletId  = tontine.walletId!;
  const expectedRound = tontine.currentRound + 1;

  // ── Growth tontine: compound contribution_amount before this cycle ────────────
  if (tontine.tontineType === "growth" && tontine.growthRate) {
    const growthRate    = Number(tontine.growthRate);
    const prevAmount    = Number(tontine.contributionAmount);
    const newAmount     = prevAmount * (1 + growthRate / 100);
    const newAmountStr  = newAmount.toFixed(4);
    await db.update(tontinesTable)
      .set({ contributionAmount: newAmountStr, updatedAt: new Date() })
      .where(eq(tontinesTable.id, tontineId));
    await audit({
      action:   "tontine.growth.rate_applied",
      entity:   "tontine",
      entityId: tontineId,
      metadata: { previousAmount: prevAmount, newAmount, growthRate, round: expectedRound },
    });
    tontine.contributionAmount = newAmountStr;
  }

  const defaultAmount   = Number(tontine.contributionAmount);
  let collected         = 0;
  let totalCollected    = 0;
  let yieldCollected    = 0;
  const failed: string[] = [];

  for (const member of members) {
    if (member.contributionsCount >= expectedRound) {
      continue;
    }
    // Skip suspended members
    if ((member as any).memberStatus === "suspended") {
      failed.push(member.userId);
      continue;
    }

    // Multi-amount: use member's personal contribution if set, else tontine default
    const memberAmount = Number(member.personalContribution ?? defaultAmount);
    // Yield tontine: collect any unpaid yield surcharge on top of base contribution
    const yieldSurcharge = tontine.tontineType === "yield"
      ? Math.max(0, Number(member.yieldOwed ?? 0) - Number(member.yieldPaid ?? 0))
      : 0;
    const totalDebit = memberAmount + yieldSurcharge;

    const memberWallets = await db.select().from(walletsTable)
      .where(and(eq(walletsTable.userId, member.userId), eq(walletsTable.status, "active")));
    const wallet =
      memberWallets.find(w => w.walletType === "personal") ??
      memberWallets.find(w => w.walletType !== "tontine") ??
      memberWallets[0];
    if (!wallet || wallet.id === poolWalletId) { failed.push(member.userId); continue; }

    try {
      await processTransfer({
        fromWalletId: wallet.id,
        toWalletId:   poolWalletId,
        amount:       totalDebit,
        currency,
        description:  `Tontine contribution – Round ${expectedRound}${yieldSurcharge > 0 ? ` (+${yieldSurcharge.toFixed(2)} yield)` : ""}`,
        skipFraudCheck: true,
      });
      const memberUpdates: Record<string, any> = {
        contributionsCount: sql`${tontineMembersTable.contributionsCount} + 1`,
      };
      if (yieldSurcharge > 0) {
        memberUpdates.yieldPaid = String((Number(member.yieldPaid ?? 0) + yieldSurcharge).toFixed(4));
        yieldCollected += yieldSurcharge;
      }
      await db.update(tontineMembersTable).set(memberUpdates).where(eq(tontineMembersTable.id, member.id));
      collected++;
      totalCollected += memberAmount;
    } catch {
      failed.push(member.userId);

      // ── Missed contribution tracking ──────────────────────────────────────
      const currentMissed = Number((member as any).missedContributions ?? 0);
      const newMissed = currentMissed + 1;
      const updates: Record<string, any> = {
        missedContributions: newMissed,
      };

      if (newMissed >= 3) {
        // Suspend member
        updates.memberStatus = "suspended";

        await audit({
          action:   "tontine_missed_contribution",
          entity:   "tontine_member",
          entityId: member.id,
          metadata: { tontineId, userId: member.userId, missedCount: newMissed, round: expectedRound },
        });

        // Notify suspended member
        await eventBus.publish("tontine.member.suspended", {
          tontineId,
          userId: member.userId,
          missedContributions: newMissed,
          round: expectedRound,
        });

        // Notify admin
        await eventBus.publish("tontine.member.suspended", {
          tontineId,
          userId: tontine.adminUserId,
          isAdminNotification: true,
          suspendedUserId: member.userId,
          missedContributions: newMissed,
        });
      } else if (newMissed >= 2) {
        await audit({
          action:   "tontine_missed_contribution",
          entity:   "tontine_member",
          entityId: member.id,
          metadata: { tontineId, userId: member.userId, missedCount: newMissed, round: expectedRound },
        });

        // Warn member at 2 misses
        await eventBus.publish("tontine.member.contribution_warning", {
          tontineId,
          userId: member.userId,
          missedContributions: newMissed,
          round: expectedRound,
        });
      }

      await db.update(tontineMembersTable).set(updates).where(eq(tontineMembersTable.id, member.id));
    }
  }

  // Persist yield collected this cycle → add to tontine's yield_pool_balance
  if (yieldCollected > 0) {
    const [cur] = await db.select({ y: tontinesTable.yieldPoolBalance }).from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    const newBal = (Number(cur?.y ?? 0) + yieldCollected).toFixed(4);
    await db.update(tontinesTable).set({ yieldPoolBalance: newBal, updatedAt: new Date() }).where(eq(tontinesTable.id, tontineId));
  }

  await eventBus.publish("tontine.contributions.collected", { tontineId, collected, failed, round: expectedRound, yieldCollected });

  await createSchedulerJob("tontine_payout", tontineId, "tontine", new Date());

  // Step 3: Auto-release purchase goals when goal_reached condition is met
  try {
    const [poolWallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, poolWalletId));
    if (poolWallet) {
      const poolBalance = Number(poolWallet.balance);
      const openGoals = await db.select().from(tontinePurchaseGoalsTable)
        .where(and(
          eq(tontinePurchaseGoalsTable.tontineId, tontineId),
          eq(tontinePurchaseGoalsTable.status, "open"),
          eq(tontinePurchaseGoalsTable.releaseCondition, "goal_reached"),
        ));

      for (const goal of openGoals) {
        const goalAmt = Number(goal.goalAmount);
        const updatedCurrent = Math.min(poolBalance, goalAmt);

        await db.update(tontinePurchaseGoalsTable)
          .set({ currentAmount: String(updatedCurrent) })
          .where(eq(tontinePurchaseGoalsTable.id, goal.id));

        if (poolBalance >= goalAmt) {
          // Auto-release: transfer to vendor wallet if known
          if (goal.vendorWalletId) {
            try {
              await processTransfer({
                fromWalletId:   poolWalletId,
                toWalletId:     goal.vendorWalletId,
                amount:         goalAmt,
                currency,
                description:    `Tontine project auto-release: ${goal.goalDescription}`,
                skipFraudCheck: true,
              });
            } catch (e) {
              console.error(`[tontineScheduler] vendor transfer failed for goal ${goal.id}:`, e);
            }
          }
          await db.update(tontinePurchaseGoalsTable).set({
            status:        "released",
            releasedAt:    new Date(),
            currentAmount: String(goalAmt),
          }).where(eq(tontinePurchaseGoalsTable.id, goal.id));

          await eventBus.publish("tontine.goal.released", {
            tontineId,
            goalId:         goal.id,
            vendorName:     goal.vendorName,
            amount:         goalAmt,
            currency,
            trigger:        "auto_goal_reached",
            pendingPayout:  !goal.vendorWalletId,
          });
        }
      }
    }
  } catch (e) {
    console.error(`[tontineScheduler] auto-release check failed for tontine ${tontineId}:`, e);
  }

  return { collected, failed, totalCollected };
}

export async function runPayoutCycle(tontineId: string): Promise<{
  recipientUserId: string; amount: number; round: number;
}> {
  const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
  if (!tontine) throw new Error(`Tontine ${tontineId} not found`);
  if (tontine.status !== "active") throw new Error(`Tontine ${tontineId} is not active`);

  // ── Hybrid type: delegate entirely to runHybridCycle ─────────────────────
  if (tontine.tontineType === "hybrid") {
    return runHybridCycle(tontineId);
  }

  const nextOrder = tontine.currentRound + 1;
  const [recipient] = await db.select().from(tontineMembersTable)
    .where(and(
      eq(tontineMembersTable.tontineId, tontineId),
      eq(tontineMembersTable.payoutOrder, nextOrder),
    ));

  if (!recipient) throw new Error(`No recipient found for round ${nextOrder}`);

  const memberLocked = await db.update(tontineMembersTable)
    .set({ hasReceivedPayout: 2 })
    .where(and(
      eq(tontineMembersTable.id, recipient.id),
      eq(tontineMembersTable.hasReceivedPayout, 0),
    ))
    .returning({ id: tontineMembersTable.id });

  if (!memberLocked.length) throw new Error("Payout already in progress or completed for this member");

  try {
    const recipientWallets = await db.select().from(walletsTable)
      .where(and(eq(walletsTable.userId, recipient.userId), eq(walletsTable.status, "active")));
    const recipientWallet =
      recipientWallets.find(w => w.walletType === "personal") ??
      recipientWallets.find(w => w.walletType !== "tontine") ??
      recipientWallets[0];
    if (!recipientWallet) throw new Error(`Recipient wallet not found`);
    if (recipientWallet.id === tontine.walletId) throw new Error(`Recipient wallet resolves to the pool wallet — check adminUserId wallet setup`);

    // Multi-amount: payout = sum of each member's personal contribution (or tontine default)
    const allMembers   = await db.select().from(tontineMembersTable).where(eq(tontineMembersTable.tontineId, tontineId));
    const defaultAmt   = Number(tontine.contributionAmount);
    const payoutAmount = allMembers.reduce((sum, m) => sum + Number(m.personalContribution ?? defaultAmt), 0);

    // ── Yield tontine mechanics ───────────────────────────────────────────────
    let yieldShare = 0;
    let yieldOwed  = 0;
    const yieldPoolBal = Number(tontine.yieldPoolBalance ?? 0);

    if (tontine.tontineType === "yield" && tontine.yieldRate) {
      const yieldRate           = Number(tontine.yieldRate);
      const remainingAfter      = tontine.totalRounds - nextOrder;       // rounds AFTER this one
      const remainingInclusive  = tontine.totalRounds - nextOrder + 1;   // including current round

      // Early recipient: owes interest back to pool (proportional to rounds remaining)
      yieldOwed = payoutAmount * (yieldRate / 100) * (remainingAfter / tontine.totalRounds);

      // Current recipient's fair share of accumulated yield pool
      yieldShare = remainingInclusive > 0
        ? yieldPoolBal / remainingInclusive
        : yieldPoolBal;
    }

    const actualPayoutAmount = payoutAmount + yieldShare;

    await processTransfer({
      fromWalletId: tontine.walletId!,
      toWalletId:   recipientWallet.id,
      amount:       actualPayoutAmount,
      currency:     tontine.currency,
      description:  `Tontine payout – Round ${nextOrder}${yieldShare > 0 ? ` (+${yieldShare.toFixed(2)} yield share)` : ""}`,
      skipFraudCheck: true,
    });

    const newRound       = nextOrder;
    const isComplete     = newRound >= tontine.totalRounds;
    const nextPayoutDate = computeNextDate(tontine.frequency);
    const newYieldPool   = Math.max(0, yieldPoolBal - yieldShare).toFixed(4);

    await db.transaction(async (tx) => {
      await tx.update(tontineMembersTable)
        .set({
          hasReceivedPayout: 1,
          receivedPayoutAt:  new Date(),
          yieldOwed:         yieldOwed > 0 ? String(yieldOwed.toFixed(4)) : "0",
        })
        .where(eq(tontineMembersTable.id, recipient.id));

      await tx.update(tontinesTable).set({
        currentRound:    newRound,
        status:          isComplete ? "completed" : "active",
        nextPayoutDate:  isComplete ? null : nextPayoutDate,
        yieldPoolBalance: newYieldPool,
        updatedAt:       new Date(),
      }).where(eq(tontinesTable.id, tontineId));
    });

    await audit({
      action:   "tontine.payout.completed",
      entity:   "tontine",
      entityId: tontineId,
      metadata: { round: newRound, recipientUserId: recipient.userId, payoutAmount: actualPayoutAmount, yieldShare, yieldOwed },
    });

    await eventBus.publish("tontine.payout.completed", {
      tontineId, round: newRound, recipientUserId: recipient.userId,
      payoutAmount: actualPayoutAmount, yieldShare, yieldOwed,
    });

    return { recipientUserId: recipient.userId, amount: actualPayoutAmount, round: newRound };
  } catch (err) {
    await db.update(tontineMembersTable)
      .set({ hasReceivedPayout: 0 })
      .where(eq(tontineMembersTable.id, recipient.id));
    throw err;
  }
}

export function computeNextDate(frequency: string): Date {
  const d = new Date();
  if (frequency === "weekly")   d.setDate(d.getDate() + 7);
  else if (frequency === "biweekly") d.setDate(d.getDate() + 14);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

export async function assignPayoutOrder(tontineId: string, model: RotationModel): Promise<void> {
  const members = await db.select().from(tontineMembersTable)
    .where(eq(tontineMembersTable.tontineId, tontineId))
    .orderBy(asc(tontineMembersTable.payoutOrder));

  if (model === "fixed") return;

  let ordered: typeof members;

  if (model === "random") {
    ordered = [...members].sort(() => (randomBytes(1)[0] % 2 === 0 ? 1 : -1));
  } else if (model === "auction") {
    const bids = await db.select().from(tontineBidsTable)
      .where(and(eq(tontineBidsTable.tontineId, tontineId), eq(tontineBidsTable.status, "pending")));
    const bidMap = new Map(bids.map(b => [b.userId, Number(b.bidAmount)]));
    ordered = [...members].sort((a, b) => (bidMap.get(b.userId) ?? 0) - (bidMap.get(a.userId) ?? 0));
    await db.update(tontineBidsTable)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(tontineBidsTable.tontineId, tontineId));
  } else {
    return;
  }

  for (let i = 0; i < ordered.length; i++) {
    await db.update(tontineMembersTable)
      .set({ payoutOrder: i + 1 })
      .where(eq(tontineMembersTable.id, ordered[i].id));
  }

  await eventBus.publish("tontine.rotation.assigned", { tontineId, model, memberCount: members.length });
}

export async function listPositionForSale(params: {
  tontineId: string; sellerId: string; payoutOrder: number; askPrice: number; currency: string; expiresAt?: Date;
}): Promise<typeof tontinePositionListingsTable.$inferSelect> {
  const { tontineId, sellerId, payoutOrder, askPrice, currency, expiresAt } = params;

  const [existing] = await db.select().from(tontinePositionListingsTable)
    .where(and(
      eq(tontinePositionListingsTable.tontineId, tontineId),
      eq(tontinePositionListingsTable.sellerId, sellerId),
      eq(tontinePositionListingsTable.status, "open"),
    ));
  if (existing) throw new Error("Position already listed for sale");

  const [listing] = await db.insert(tontinePositionListingsTable).values({
    id: generateId(),
    tontineId, sellerId, payoutOrder,
    askPrice: String(askPrice), currency,
    status: "open",
    expiresAt: expiresAt ?? null,
  }).returning();

  await eventBus.publish("tontine.position.listed", { tontineId, sellerId, payoutOrder, askPrice });
  return listing;
}

export async function buyTontinePosition(listingId: string, buyerId: string): Promise<void> {
  const claimed = await db.update(tontinePositionListingsTable)
    .set({ status: "processing" })
    .where(and(
      eq(tontinePositionListingsTable.id, listingId),
      eq(tontinePositionListingsTable.status, "open"),
    ))
    .returning();

  if (!claimed.length) throw new Error("Listing not available or already purchased");
  const listing = claimed[0];

  if (listing.sellerId === buyerId) {
    await db.update(tontinePositionListingsTable)
      .set({ status: "open" })
      .where(eq(tontinePositionListingsTable.id, listingId));
    throw new Error("Cannot buy your own position");
  }

  try {
    const buyerWallets  = await db.select().from(walletsTable).where(and(eq(walletsTable.userId, buyerId),  eq(walletsTable.status, "active")));
    const sellerWallets = await db.select().from(walletsTable).where(and(eq(walletsTable.userId, listing.sellerId), eq(walletsTable.status, "active")));

    const prefer = (ws: typeof walletsTable.$inferSelect[]) =>
      ws.find(w => w.walletType === "personal") ?? ws.find(w => Number(w.availableBalance) > 0) ?? ws[0];

    const buyerWallet  = prefer(buyerWallets);
    const sellerWallet = prefer(sellerWallets);
    if (!buyerWallet || !sellerWallet) throw new Error("Wallet not found");

    const tx = await processTransfer({
      fromWalletId: buyerWallet.id,
      toWalletId:   sellerWallet.id,
      amount:       Number(listing.askPrice),
      currency:     listing.currency,
      description:  `Tontine position purchase – listing ${listingId}`,
      skipFraudCheck: true,
    });

    await db.transaction(async (dbTx) => {
      await dbTx.update(tontineMembersTable)
        .set({ userId: buyerId })
        .where(and(
          eq(tontineMembersTable.tontineId, listing.tontineId),
          eq(tontineMembersTable.payoutOrder, listing.payoutOrder),
        ));

      await dbTx.update(tontinePositionListingsTable).set({
        status: "sold", buyerId, soldAt: new Date(), transactionId: tx.id,
      }).where(eq(tontinePositionListingsTable.id, listingId));
    });

    await eventBus.publish("tontine.position.sold", {
      tontineId: listing.tontineId, buyerId, sellerId: listing.sellerId,
      payoutOrder: listing.payoutOrder, price: listing.askPrice,
    });
  } catch (err) {
    await db.update(tontinePositionListingsTable)
      .set({ status: "open" })
      .where(eq(tontinePositionListingsTable.id, listingId));
    throw err;
  }
}

export async function createSchedulerJob(
  jobType: string, entityId: string, entityType: string, scheduledAt: Date, metadata?: Record<string, unknown>
): Promise<void> {
  await db.insert(schedulerJobsTable).values({
    id: generateId(), jobType, entityId, entityType,
    scheduledAt, status: "pending", metadata: metadata ?? null,
  });
}

// ── Hybrid Cycle ──────────────────────────────────────────────────────────────
type HybridConfig = {
  rotation_pct: number; investment_pct: number;
  solidarity_pct: number; yield_pct: number;
  rebalance_each_cycle?: boolean;
};

export async function runHybridCycle(tontineId: string): Promise<{
  recipientUserId: string; amount: number; round: number;
}> {
  const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
  if (!tontine)               throw new Error(`Tontine ${tontineId} not found`);
  if (tontine.status !== "active") throw new Error(`Tontine ${tontineId} is not active`);
  if (!tontine.hybridConfig)  throw new Error(`Tontine ${tontineId} has no hybrid_config — set it via POST /hybrid-config first`);
  if (!tontine.walletId)      throw new Error(`Tontine ${tontineId} has no pool wallet`);

  const cfg   = tontine.hybridConfig as HybridConfig;
  const round = tontine.currentRound + 1;
  const currency = tontine.currency;

  // ── Get pool wallet balance (= what was collected in this cycle) ──────────
  const [poolWallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, tontine.walletId));
  if (!poolWallet) throw new Error("Pool wallet not found");

  // Available = balance minus already-reserved solidarity fund
  const existingReserve = Number(tontine.solidarityReserve ?? 0);
  const totalBalance    = Number(poolWallet.balance);
  const available       = Math.max(0, totalBalance - existingReserve);

  if (available <= 0) throw new Error("No funds available for hybrid distribution (all reserved as solidarity)");

  const rotationAmount   = parseFloat((available * (cfg.rotation_pct   / 100)).toFixed(4));
  const investmentAmount = parseFloat((available * (cfg.investment_pct  / 100)).toFixed(4));
  const solidarityAmount = parseFloat((available * (cfg.solidarity_pct  / 100)).toFixed(4));
  const yieldAmount      = parseFloat((available * (cfg.yield_pct       / 100)).toFixed(4));

  // ── 1. Rotation: pay the next member ─────────────────────────────────────
  const [recipient] = await db.select().from(tontineMembersTable)
    .where(and(eq(tontineMembersTable.tontineId, tontineId), eq(tontineMembersTable.payoutOrder, round)));
  if (!recipient) throw new Error(`No recipient found for round ${round}`);

  const claimed = await db.update(tontineMembersTable)
    .set({ hasReceivedPayout: 2 })
    .where(and(eq(tontineMembersTable.id, recipient.id), eq(tontineMembersTable.hasReceivedPayout, 0)))
    .returning({ id: tontineMembersTable.id });
  if (!claimed.length) throw new Error("Payout already in progress or completed for this member");

  try {
    const recipientWallets = await db.select().from(walletsTable)
      .where(and(eq(walletsTable.userId, recipient.userId), eq(walletsTable.status, "active")));
    const recipientWallet  =
      recipientWallets.find(w => w.walletType === "personal") ??
      recipientWallets.find(w => w.walletType !== "tontine") ??
      recipientWallets[0];
    if (!recipientWallet || recipientWallet.id === tontine.walletId) {
      throw new Error("Recipient wallet not found or resolves to pool wallet");
    }

    if (rotationAmount > 0) {
      await processTransfer({
        fromWalletId: tontine.walletId!,
        toWalletId:   recipientWallet.id,
        amount:       rotationAmount,
        currency,
        description:  `Hybrid tontine payout – Round ${round} (${cfg.rotation_pct}% rotation)`,
        skipFraudCheck: true,
      });
    }

    // ── 2. Investment: transfer to pool wallet ────────────────────────────
    if (investmentAmount > 0 && tontine.investmentPoolId) {
      const [invPool] = await db.select().from(investmentPoolsTable)
        .where(eq(investmentPoolsTable.id, tontine.investmentPoolId));
      if (invPool?.walletId) {
        await processTransfer({
          fromWalletId: tontine.walletId!,
          toWalletId:   invPool.walletId,
          amount:       investmentAmount,
          currency,
          description:  `Hybrid tontine – Investment tranche Round ${round}`,
          skipFraudCheck: true,
        });
        // Update investment pool running total
        await db.update(investmentPoolsTable)
          .set({ currentAmount: sql`${investmentPoolsTable.currentAmount}::numeric + ${investmentAmount}` })
          .where(eq(investmentPoolsTable.id, tontine.investmentPoolId));

        // Update or create pool positions proportionally for each member
        const allMembers = await db.select().from(tontineMembersTable).where(eq(tontineMembersTable.tontineId, tontineId));
        const perMemberInvestment = parseFloat((investmentAmount / allMembers.length).toFixed(4));
        for (const m of allMembers) {
          const [pos] = await db.select().from(poolPositionsTable)
            .where(and(eq(poolPositionsTable.poolId, tontine.investmentPoolId), eq(poolPositionsTable.userId, m.userId)));
          if (pos) {
            await db.update(poolPositionsTable)
              .set({ investedAmount: sql`${poolPositionsTable.investedAmount}::numeric + ${perMemberInvestment}`, updatedAt: new Date() })
              .where(eq(poolPositionsTable.id, pos.id));
          } else {
            await db.insert(poolPositionsTable).values({
              id: generateId(), poolId: tontine.investmentPoolId, userId: m.userId,
              investedAmount: String(perMemberInvestment), currency, status: "active",
              shares: String(perMemberInvestment),
            });
          }
        }
      }
    }

    // ── 3. Solidarity: keep in pool, update solidarity_reserve balance ────
    const newReserve = existingReserve + solidarityAmount;
    await audit({
      action:    "tontine.hybrid.solidarity_reserve_tagged",
      entity:    "tontine",
      entityId:  tontineId,
      metadata:  { round, solidarityAmount, newReserve, tag: "SOLIDARITY_RESERVE" },
    });

    // ── 4. Yield: distribute equally to already-paid members ─────────────
    let yieldRecipients = 0;
    if (yieldAmount > 0) {
      const paidMembers = (await db.select().from(tontineMembersTable)
        .where(and(eq(tontineMembersTable.tontineId, tontineId), eq(tontineMembersTable.hasReceivedPayout, 1)))
      ).filter(m => m.id !== recipient.id);

      if (paidMembers.length > 0) {
        const perMemberYield = parseFloat((yieldAmount / paidMembers.length).toFixed(4));
        for (const pm of paidMembers) {
          const pmWallets = await db.select().from(walletsTable)
            .where(and(eq(walletsTable.userId, pm.userId), eq(walletsTable.status, "active")));
          const pmWallet  =
            pmWallets.find(w => w.walletType === "personal") ??
            pmWallets.find(w => w.walletType !== "tontine") ??
            pmWallets[0];
          if (!pmWallet || pmWallet.id === tontine.walletId) continue;
          try {
            await processTransfer({
              fromWalletId: tontine.walletId!,
              toWalletId:   pmWallet.id,
              amount:       perMemberYield,
              currency,
              description:  `Hybrid yield bonus – Round ${round} patience reward`,
              skipFraudCheck: true,
            });
            yieldRecipients++;
          } catch (e) {
            console.error(`[hybrid] yield transfer to ${pm.userId} failed:`, e);
          }
        }
      }
    }

    // ── Persist cycle record + update tontine state ───────────────────────
    const isComplete = round >= tontine.totalRounds;

    await db.transaction(async (tx) => {
      await tx.insert(tontineHybridCyclesTable).values({
        id: generateId(), tontineId, round,
        totalPool:        String(available.toFixed(4)),
        rotationAmount:   String(rotationAmount.toFixed(4)),
        investmentAmount: String(investmentAmount.toFixed(4)),
        solidarityAmount: String(solidarityAmount.toFixed(4)),
        yieldAmount:      String(yieldAmount.toFixed(4)),
        recipientUserId:  recipient.userId,
        yieldRecipients,
        metadata: { cfg, existingReserve, newReserve },
      });

      await tx.update(tontineMembersTable).set({
        hasReceivedPayout: 1,
        receivedPayoutAt:  new Date(),
      }).where(eq(tontineMembersTable.id, recipient.id));

      await tx.update(tontinesTable).set({
        currentRound:     round,
        status:           isComplete ? "completed" : "active",
        nextPayoutDate:   isComplete ? null : computeNextDate(tontine.frequency),
        solidarityReserve: String(newReserve.toFixed(4)),
        updatedAt:        new Date(),
      }).where(eq(tontinesTable.id, tontineId));
    });

    await audit({
      action:   "tontine.hybrid.cycle_completed",
      entity:   "tontine",
      entityId: tontineId,
      metadata: {
        round, totalPool: available, rotationAmount, investmentAmount,
        solidarityAmount, yieldAmount, yieldRecipients,
        recipientUserId: recipient.userId,
      },
    });

    await eventBus.publish("tontine.hybrid.cycle_completed", {
      tontineId, round, rotationAmount, investmentAmount, solidarityAmount, yieldAmount, yieldRecipients,
    });

    return { recipientUserId: recipient.userId, amount: rotationAmount, round };
  } catch (err) {
    await db.update(tontineMembersTable)
      .set({ hasReceivedPayout: 0 })
      .where(eq(tontineMembersTable.id, recipient.id));
    throw err;
  }
}

export async function getPendingJobs(jobType?: string) {
  const where = jobType
    ? and(eq(schedulerJobsTable.jobType, jobType as any), eq(schedulerJobsTable.status, "pending"))
    : eq(schedulerJobsTable.status, "pending");
  return db.select().from(schedulerJobsTable).where(where).orderBy(asc(schedulerJobsTable.scheduledAt));
}

export async function distributeToTargets(tontineId: string): Promise<{
  distributed: number; failed: string[]; totalDistributed: number;
}> {
  const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
  if (!tontine) throw new Error(`Tontine ${tontineId} not found`);
  if (!tontine.strategyMode) throw new Error(`Tontine ${tontineId} is not in strategy mode`);
  if (!tontine.walletId)     throw new Error(`Tontine ${tontineId} has no pool wallet`);

  const targets = await db.select().from(tontineStrategyTargetsTable)
    .where(and(eq(tontineStrategyTargetsTable.tontineId, tontineId), eq(tontineStrategyTargetsTable.status, "funded")));

  if (!targets.length) throw new Error("No funded strategy targets found");

  const distributed: number  = 0;
  const failed: string[]     = [];
  let   totalDistributed     = 0;

  for (const target of targets) {
    const [merchant] = await db.select().from(merchantsTable).where(eq(merchantsTable.id, target.merchantId));
    if (!merchant) { failed.push(`target ${target.id}: merchant not found`); continue; }

    try {
      const amount = Number(target.allocatedAmount);
      await processTransfer({
        fromWalletId: tontine.walletId!,
        toWalletId:   merchant.walletId,
        amount,
        currency:     tontine.currency,
        description:  `Strategy distribution – ${tontine.name} → ${merchant.businessName}`,
        reference:    `STRAT-${tontineId}-${target.id}`,
        initiatedBy:  tontine.adminUserId,
        type:         "tontine_strategy_fund",
      });

      await db.update(tontineStrategyTargetsTable).set({
        status:   "active",
        fundedAt: new Date(),
      }).where(eq(tontineStrategyTargetsTable.id, target.id));

      totalDistributed += amount;
      await eventBus.publish("tontine.strategy.target_funded", {
        tontineId, targetId: target.id, merchantId: target.merchantId, amount,
      });
    } catch (err: any) {
      failed.push(`target ${target.id}: ${err.message}`);
    }
  }

  await audit({
    action:    "strategy_distribution",
    entityId:  tontineId,
    entityType:"tontine",
    metadata:  { totalDistributed, failedCount: failed.length },
  });

  return { distributed: targets.length - failed.length, failed, totalDistributed };
}

// ── P2-A: Crash recovery for stuck payouts ───────────────────────────────────
//
// At startup, scan for tontine_members where hasReceivedPayout = 2 (in-progress
// sentinel). These indicate a crash occurred AFTER the processTransfer call but
// BEFORE the db.transaction marking the member as fully paid.
//
// Strategy:
//   1. If tontine.currentRound >= member.payoutOrder:
//      The final db.transaction DID commit (tontine round was advanced).
//      The member record just wasn't updated. Safe to set hasReceivedPayout = 1.
//
//   2. Else if a "tontine_payout" transaction to the recipient's wallet exists:
//      processTransfer committed (money sent) but the final tx did not.
//      Advance state atomically: set member = 1, update tontine round.
//
//   3. Else:
//      Neither transfer nor final tx committed. Safe to reset to 0 for retry.
//
export async function recoverStuckPayouts(): Promise<void> {
  const stuck = await db.select({
    id:          tontineMembersTable.id,
    tontineId:   tontineMembersTable.tontineId,
    userId:      tontineMembersTable.userId,
    payoutOrder: tontineMembersTable.payoutOrder,
  }).from(tontineMembersTable)
    .where(eq(tontineMembersTable.hasReceivedPayout, 2));

  if (stuck.length === 0) return;

  console.warn(`[RecoverStuckPayouts] Found ${stuck.length} stuck member(s) — recovering...`);

  for (const member of stuck) {
    try {
      const [tontine] = await db.select().from(tontinesTable)
        .where(eq(tontinesTable.id, member.tontineId));
      if (!tontine) continue;

      // Case 1: tontine round was already advanced — just mark member as paid
      if (tontine.currentRound >= member.payoutOrder) {
        await db.update(tontineMembersTable)
          .set({ hasReceivedPayout: 1, receivedPayoutAt: new Date() })
          .where(eq(tontineMembersTable.id, member.id));

        await audit({
          action:   "tontine.payout.crash_recovery.marked_paid",
          entity:   "tontine_member",
          entityId: member.id,
          metadata: { tontineId: member.tontineId, payoutOrder: member.payoutOrder, reason: "tontine_round_advanced" },
        });
        console.warn(`[RecoverStuckPayouts] Member ${member.id} set to paid (tontine round already advanced).`);
        continue;
      }

      // Case 2: check if a payout transaction was committed to recipient's wallet
      const recipientWallets = await db.select({ id: walletsTable.id })
        .from(walletsTable)
        .where(and(eq(walletsTable.userId, member.userId), eq(walletsTable.status, "active")));
      const recipientWalletIds = recipientWallets.map(w => w.id);

      let transferFound = false;
      for (const walletId of recipientWalletIds) {
        const [txn] = await db.select({ id: transactionsTable.id })
          .from(transactionsTable)
          .where(and(
            eq(transactionsTable.toWalletId, walletId),
            like(transactionsTable.description, `%Tontine payout – Round ${member.payoutOrder}%`),
          ))
          .limit(1);
        if (txn) { transferFound = true; break; }
      }

      if (transferFound) {
        // Transfer was made — advance state atomically
        const isComplete = member.payoutOrder >= tontine.totalRounds;
        await db.transaction(async (tx) => {
          await tx.update(tontineMembersTable)
            .set({ hasReceivedPayout: 1, receivedPayoutAt: new Date() })
            .where(eq(tontineMembersTable.id, member.id));
          await tx.update(tontinesTable)
            .set({
              currentRound:  member.payoutOrder,
              status:        isComplete ? "completed" : "active",
              nextPayoutDate: isComplete ? null : computeNextDate(tontine.frequency),
              updatedAt:     new Date(),
            })
            .where(eq(tontinesTable.id, tontine.id));
        });
        await audit({
          action:   "tontine.payout.crash_recovery.state_advanced",
          entity:   "tontine_member",
          entityId: member.id,
          metadata: { tontineId: member.tontineId, payoutOrder: member.payoutOrder, reason: "transfer_found_in_ledger" },
        });
        console.warn(`[RecoverStuckPayouts] Member ${member.id}: transfer found — state advanced to round ${member.payoutOrder}.`);
      } else {
        // No transfer found — safe to reset for retry
        await db.update(tontineMembersTable)
          .set({ hasReceivedPayout: 0 })
          .where(eq(tontineMembersTable.id, member.id));
        await audit({
          action:   "tontine.payout.crash_recovery.reset_for_retry",
          entity:   "tontine_member",
          entityId: member.id,
          metadata: { tontineId: member.tontineId, payoutOrder: member.payoutOrder, reason: "no_transfer_found" },
        });
        console.warn(`[RecoverStuckPayouts] Member ${member.id}: no transfer found — reset to unpaid for retry.`);
      }
    } catch (err) {
      console.error(`[RecoverStuckPayouts] Failed to recover member ${member.id}:`, err);
    }
  }

  console.info("[RecoverStuckPayouts] Recovery complete.");
}
