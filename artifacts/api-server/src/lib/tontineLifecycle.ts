import { db } from "@workspace/db";
import {
  tontinesTable, tontineMembersTable, walletsTable, schedulerJobsTable,
  tontinePositionListingsTable, tontineBidsTable,
} from "@workspace/db";
import { eq, and, asc, inArray } from "drizzle-orm";
import { generateId } from "./id";
import { processTransfer, getWalletBalance, isDuplicateIdempotencyKey } from "./walletService";
import { buyTontinePosition } from "./tontineScheduler";
import { eventBus } from "./eventBus";
import { audit } from "./auditLogger";

const LEAVE_PENALTY_PCT = (() => {
  const v = Number(process.env.TONTINE_LEAVE_PENALTY_PCT);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 10;
})();

type TontineRow = typeof tontinesTable.$inferSelect;
type MemberRow = typeof tontineMembersTable.$inferSelect;

async function memberPersonalWallet(userId: string, currency: string, excludeWalletId: string | null): Promise<string | null> {
  const wallets = (await db.select().from(walletsTable)
    .where(and(eq(walletsTable.userId, userId), eq(walletsTable.status, "active"))))
    .filter(w => w.currency === currency && w.id !== excludeWalletId);
  const wallet = wallets.find(w => w.walletType === "personal") ?? wallets.find(w => w.walletType !== "tontine") ?? wallets[0];
  return wallet?.id ?? null;
}

function contributedTotal(tontine: TontineRow, member: MemberRow): number {
  const perRound = Number(member.personalContribution ?? tontine.contributionAmount);
  return Math.round(perRound * member.contributionsCount * 10000) / 10000;
}

async function cancelPendingJobs(tontineId: string): Promise<number> {
  const cancelled = await db.update(schedulerJobsTable)
    .set({ status: "cancelled", error: "tontine lifecycle change" })
    .where(and(eq(schedulerJobsTable.entityId, tontineId), eq(schedulerJobsTable.status, "pending")))
    .returning({ id: schedulerJobsTable.id });
  return cancelled.length;
}

async function closeOpenMarket(tontineId: string): Promise<void> {
  await db.update(tontinePositionListingsTable)
    .set({ status: "cancelled" })
    .where(and(eq(tontinePositionListingsTable.tontineId, tontineId), inArray(tontinePositionListingsTable.status, ["open", "processing"])));
  await db.update(tontineBidsTable)
    .set({ status: "rejected", resolvedAt: new Date() })
    .where(and(eq(tontineBidsTable.tontineId, tontineId), eq(tontineBidsTable.status, "pending")));
}

async function compactPayoutOrder(tontineId: string): Promise<void> {
  const remaining = await db.select().from(tontineMembersTable)
    .where(eq(tontineMembersTable.tontineId, tontineId))
    .orderBy(asc(tontineMembersTable.payoutOrder));
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].payoutOrder !== i + 1) {
      await db.update(tontineMembersTable).set({ payoutOrder: i + 1 }).where(eq(tontineMembersTable.id, remaining[i].id));
    }
  }
}

// A member of an active tontine may leave only before receiving their payout. Their
// contributions come back from the pool minus a penalty that stays with the group.
export async function leaveActiveTontine(tontineId: string, userId: string): Promise<{
  refundAmount: number; penalty: number; contributed: number; remainingMembers: number;
}> {
  const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
  if (!tontine) throw new Error("Tontine not found");
  if (tontine.status !== "active") throw new Error("Tontine is not active");
  if (!tontine.walletId) throw new Error("Tontine has no pool wallet");
  if (tontine.adminUserId === userId) throw new Error("Admin cannot leave their own tontine — cancel it instead");

  const [member] = await db.select().from(tontineMembersTable)
    .where(and(eq(tontineMembersTable.tontineId, tontineId), eq(tontineMembersTable.userId, userId)));
  if (!member) throw new Error("Member not found in this tontine");
  if (member.hasReceivedPayout === 1) throw new Error("Cannot leave after receiving your payout — the group is still owed your remaining contributions");
  if (member.hasReceivedPayout === 2) throw new Error("A payout to this member is in progress");

  const contributed = contributedTotal(tontine, member);
  const penalty = Math.round(contributed * (LEAVE_PENALTY_PCT / 100) * 10000) / 10000;
  const refundAmount = Math.round((contributed - penalty) * 10000) / 10000;

  if (refundAmount > 0) {
    const poolBalance = await getWalletBalance(tontine.walletId);
    if (poolBalance + 1e-6 < refundAmount) {
      throw new Error(`Pool wallet holds ${poolBalance.toFixed(2)} ${tontine.currency}; refund of ${refundAmount.toFixed(2)} cannot be honoured right now`);
    }
    const walletId = await memberPersonalWallet(userId, tontine.currency, tontine.walletId);
    if (!walletId) throw new Error(`Member has no active ${tontine.currency} wallet to receive the refund`);
    try {
      await processTransfer({
        fromWalletId: tontine.walletId, toWalletId: walletId, amount: refundAmount, currency: tontine.currency,
        description: `Tontine exit refund – ${tontine.name}`,
        skipFraudCheck: true, skipKycCheck: true,
        idempotencyKey: `tontine-leave:${tontineId}:${member.id}`,
      });
    } catch (err) {
      if (!isDuplicateIdempotencyKey(err)) throw err;
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(tontineMembersTable).where(eq(tontineMembersTable.id, member.id));
    await tx.update(tontinesTable).set({
      memberCount: tontine.memberCount - 1,
      totalRounds: Math.max(tontine.currentRound, tontine.totalRounds - 1),
      updatedAt: new Date(),
    }).where(eq(tontinesTable.id, tontineId));
  });
  await compactPayoutOrder(tontineId);

  await audit({ action: "tontine.member.left", entity: "tontine", entityId: tontineId,
    metadata: { userId, contributed, penalty, refundAmount, rounds: member.contributionsCount } });
  await eventBus.publish("tontine.member.left", {
    tontineId, userId, refundAmount, penalty, contributed, currency: tontine.currency, tontineName: tontine.name,
  });

  return { refundAmount, penalty, contributed, remainingMembers: tontine.memberCount - 1 };
}

// Cancelling stops every scheduled cycle and returns the pool to members in proportion
// to what each is still owed (contributions minus any payout already received).
export async function cancelTontine(tontineId: string, actorId: string, reason?: string): Promise<{
  refunds: Array<{ userId: string; amount: number; currency: string; owed: number }>;
  poolBalance: number; distributed: number; jobsCancelled: number;
}> {
  const claimed = await db.update(tontinesTable)
    .set({ status: "cancelled", nextPayoutDate: null, updatedAt: new Date() })
    .where(and(eq(tontinesTable.id, tontineId), inArray(tontinesTable.status, ["pending", "active"])))
    .returning();
  if (!claimed.length) {
    const [existing] = await db.select({ status: tontinesTable.status }).from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!existing) throw new Error("Tontine not found");
    throw new Error(`Tontine is already ${existing.status}`);
  }
  const tontine = claimed[0];

  const jobsCancelled = await cancelPendingJobs(tontineId);
  await closeOpenMarket(tontineId);

  const members = await db.select().from(tontineMembersTable).where(eq(tontineMembersTable.tontineId, tontineId));
  const refunds: Array<{ userId: string; amount: number; currency: string; owed: number }> = [];
  let poolBalance = 0;
  let distributed = 0;

  if (tontine.walletId) {
    poolBalance = await getWalletBalance(tontine.walletId);
    const perRound = (m: MemberRow) => Number(m.personalContribution ?? tontine.contributionAmount);
    const potPerRound = members.reduce((s, m) => s + perRound(m), 0);
    const owedBy = members.map(m => ({
      member: m,
      owed: Math.max(0, Math.round((contributedTotal(tontine, m) - (m.hasReceivedPayout === 1 ? potPerRound : 0)) * 10000) / 10000),
    })).filter(x => x.owed > 0);
    const totalOwed = owedBy.reduce((s, x) => s + x.owed, 0);

    for (const { member, owed } of owedBy) {
      const share = totalOwed > 0 ? Math.min(owed, Math.floor((owed / totalOwed) * poolBalance * 10000) / 10000) : 0;
      if (share <= 0) { refunds.push({ userId: member.userId, amount: 0, currency: tontine.currency, owed }); continue; }
      const walletId = await memberPersonalWallet(member.userId, tontine.currency, tontine.walletId);
      if (!walletId) { refunds.push({ userId: member.userId, amount: 0, currency: tontine.currency, owed }); continue; }
      try {
        await processTransfer({
          fromWalletId: tontine.walletId, toWalletId: walletId, amount: share, currency: tontine.currency,
          description: `Tontine cancellation refund – ${tontine.name}`,
          skipFraudCheck: true, skipKycCheck: true,
          idempotencyKey: `tontine-cancel:${tontineId}:${member.id}`,
        });
        distributed += share;
        refunds.push({ userId: member.userId, amount: share, currency: tontine.currency, owed });
      } catch (err) {
        if (isDuplicateIdempotencyKey(err)) { distributed += share; refunds.push({ userId: member.userId, amount: share, currency: tontine.currency, owed }); continue; }
        console.error(`[tontineLifecycle] refund failed for ${member.userId} on ${tontineId}:`, err);
        refunds.push({ userId: member.userId, amount: 0, currency: tontine.currency, owed });
      }
    }
  }

  await audit({ action: "tontine.cancelled", entity: "tontine", entityId: tontineId, actor: actorId,
    metadata: { reason: reason ?? null, previousStatus: tontine.status, poolBalance, distributed, refunds: refunds.length, jobsCancelled } });
  await eventBus.publish("tontine.cancelled", { tontineId, tontineName: tontine.name, reason: reason ?? null, refunds, poolBalance, distributed });

  return { refunds, poolBalance, distributed, jobsCancelled };
}

// ── Secondary market offers ───────────────────────────────────────────────────

export async function placeListingBid(listingId: string, bidderId: string, bidAmount: number): Promise<typeof tontineBidsTable.$inferSelect> {
  if (!Number.isFinite(bidAmount) || bidAmount <= 0) throw new Error("bidAmount must be a positive number");
  const [listing] = await db.select().from(tontinePositionListingsTable).where(eq(tontinePositionListingsTable.id, listingId));
  if (!listing || listing.status !== "open") throw new Error("Listing is not open");
  if (listing.expiresAt && listing.expiresAt < new Date()) throw new Error("Listing has expired");
  if (listing.sellerId === bidderId) throw new Error("Cannot bid on your own listing");

  const [alreadyMember] = await db.select({ id: tontineMembersTable.id }).from(tontineMembersTable)
    .where(and(eq(tontineMembersTable.tontineId, listing.tontineId), eq(tontineMembersTable.userId, bidderId)));
  if (alreadyMember) throw new Error("You are already a member of this tontine");

  const [existing] = await db.select({ id: tontineBidsTable.id }).from(tontineBidsTable)
    .where(and(eq(tontineBidsTable.listingId, listingId), eq(tontineBidsTable.userId, bidderId), eq(tontineBidsTable.status, "pending")));
  if (existing) {
    const [updated] = await db.update(tontineBidsTable)
      .set({ bidAmount: String(bidAmount), createdAt: new Date() })
      .where(eq(tontineBidsTable.id, existing.id)).returning();
    return updated;
  }

  const [bid] = await db.insert(tontineBidsTable).values({
    id: generateId(), tontineId: listing.tontineId, userId: bidderId, listingId,
    bidAmount: String(bidAmount), desiredPosition: listing.payoutOrder, roundNumber: listing.payoutOrder,
  }).returning();
  await eventBus.publish("tontine.position.bid_placed", { tontineId: listing.tontineId, listingId, sellerId: listing.sellerId, bidderId, bidAmount });
  return bid;
}

export async function acceptListingBid(listingId: string, bidId: string, sellerId: string): Promise<{ transactionId: string; price: number; buyerId: string }> {
  const [listing] = await db.select().from(tontinePositionListingsTable).where(eq(tontinePositionListingsTable.id, listingId));
  if (!listing) throw new Error("Listing not found");
  if (listing.sellerId !== sellerId) throw new Error("Only the seller can accept a bid");
  if (listing.status !== "open") throw new Error("Listing is not open");

  const [bid] = await db.select().from(tontineBidsTable)
    .where(and(eq(tontineBidsTable.id, bidId), eq(tontineBidsTable.listingId, listingId), eq(tontineBidsTable.status, "pending")));
  if (!bid) throw new Error("Bid not found or no longer pending");

  const result = await buyTontinePosition(listingId, bid.userId, { price: Number(bid.bidAmount), bidId: bid.id });
  await audit({ action: "tontine.bid.accepted", entity: "tontine_bid", entityId: bid.id, actor: sellerId,
    metadata: { listingId, tontineId: listing.tontineId, buyerId: bid.userId, price: result.price, transactionId: result.transactionId } });
  return { ...result, buyerId: bid.userId };
}
