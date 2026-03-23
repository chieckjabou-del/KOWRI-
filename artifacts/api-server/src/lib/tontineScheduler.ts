import { db } from "@workspace/db";
import {
  tontinesTable, tontineMembersTable, walletsTable,
  tontinePositionListingsTable, tontineBidsTable, reputationScoresTable,
  schedulerJobsTable, tontinePurchaseGoalsTable,
} from "@workspace/db";
import { eq, and, sql, asc } from "drizzle-orm";
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

  const defaultAmount = Number(tontine.contributionAmount);
  const currency      = tontine.currency;
  const poolWalletId  = tontine.walletId!;
  const expectedRound = tontine.currentRound + 1;

  let collected     = 0;
  let totalCollected = 0;
  const failed: string[] = [];

  for (const member of members) {
    if (member.contributionsCount >= expectedRound) {
      continue;
    }

    // Multi-amount: use member's personal contribution if set, else tontine default
    const memberAmount = Number(member.personalContribution ?? defaultAmount);

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
        amount:       memberAmount,
        currency,
        description:  `Tontine contribution – Round ${expectedRound}`,
        skipFraudCheck: true,
      });
      await db.update(tontineMembersTable)
        .set({ contributionsCount: sql`${tontineMembersTable.contributionsCount} + 1` })
        .where(eq(tontineMembersTable.id, member.id));
      collected++;
      totalCollected += memberAmount;
    } catch {
      failed.push(member.userId);
    }
  }

  await eventBus.publish("tontine.contributions.collected", { tontineId, collected, failed, round: expectedRound });

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

    await processTransfer({
      fromWalletId: tontine.walletId!,
      toWalletId:   recipientWallet.id,
      amount:       payoutAmount,
      currency:     tontine.currency,
      description:  `Tontine payout – Round ${nextOrder}`,
      skipFraudCheck: true,
    });

    const newRound = nextOrder;
    const isComplete = newRound >= tontine.totalRounds;
    const nextPayoutDate = computeNextDate(tontine.frequency);

    await db.transaction(async (tx) => {
      await tx.update(tontineMembersTable)
        .set({ hasReceivedPayout: 1 })
        .where(eq(tontineMembersTable.id, recipient.id));

      await tx.update(tontinesTable).set({
        currentRound: newRound,
        status: isComplete ? "completed" : "active",
        nextPayoutDate: isComplete ? null : nextPayoutDate,
        updatedAt: new Date(),
      }).where(eq(tontinesTable.id, tontineId));
    });

    await audit({
      action: "tontine.payout.completed",
      entity: "tontine",
      entityId: tontineId,
      metadata: { round: newRound, recipientUserId: recipient.userId, payoutAmount },
    });

    await eventBus.publish("tontine.payout.completed", {
      tontineId, round: newRound, recipientUserId: recipient.userId, payoutAmount,
    });

    return { recipientUserId: recipient.userId, amount: payoutAmount, round: newRound };
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

export async function getPendingJobs(jobType?: string) {
  const where = jobType
    ? and(eq(schedulerJobsTable.jobType, jobType as any), eq(schedulerJobsTable.status, "pending"))
    : eq(schedulerJobsTable.status, "pending");
  return db.select().from(schedulerJobsTable).where(where).orderBy(asc(schedulerJobsTable.scheduledAt));
}
