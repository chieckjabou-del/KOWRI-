import { Router } from "express";
import { db } from "@workspace/db";
import {
  tontinesTable, tontineMembersTable, walletsTable, usersTable,
  tontinePositionListingsTable, tontineBidsTable, reputationScoresTable,
  schedulerJobsTable, tontinePurchaseGoalsTable, tontineAiAssessmentsTable,
  tontineStrategyTargetsTable, merchantsTable,
  tontineHybridCyclesTable, tontineSolidaryClaimsTable,
} from "@workspace/db";
import { eq, and, desc, count, asc, gte, isNull, lt } from "drizzle-orm";
import { audit } from "../lib/auditLogger";
import { processTransfer } from "../lib/walletService";
import { eventBus } from "../lib/eventBus";
import { generateId } from "../lib/id";
import {
  runContributionCycle, runPayoutCycle, assignPayoutOrder,
  listPositionForSale, buyTontinePosition, computeNextDate, createSchedulerJob,
} from "../lib/tontineScheduler";
import { computeReputationScore, getReputationScore, computeTontineAIPriority } from "../lib/reputationEngine";
import { requireAuth } from "../lib/productAuth";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";

const router = Router();

router.use(async (req, res, next) => {
  const auth = await requireAuth(req.headers.authorization);
  if (!auth) {
    res.status(401).json({ error: true, message: "Unauthorized. Provide a valid Bearer token." });
    return;
  }
  next();
});

router.post("/tontines/:tontineId/activate", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const { rotationModel = "fixed" } = req.body;

    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });
    if (tontine.status !== "pending") return res.status(400).json({ error: true, message: "Tontine is not pending" });

    let poolWalletId = tontine.walletId;
    if (!poolWalletId) {
      poolWalletId = generateId();
      await db.insert(walletsTable).values({
        id: poolWalletId, userId: tontine.adminUserId, currency: tontine.currency,
        balance: "0", availableBalance: "0", status: "active", walletType: "tontine",
        createdAt: new Date(), updatedAt: new Date(),
      });
      await db.update(tontinesTable).set({ walletId: poolWalletId }).where(eq(tontinesTable.id, tontineId));
    }

    await assignPayoutOrder(tontineId, rotationModel);

    const nextPayoutDate = computeNextDate(tontine.frequency);

    const [updated] = await db.update(tontinesTable)
      .set({ status: "active", nextPayoutDate, updatedAt: new Date() })
      .where(eq(tontinesTable.id, tontineId))
      .returning();

    await createSchedulerJob("tontine_contribution", tontineId, "tontine", nextPayoutDate, { rotationModel });

    res.json({
      ...updated,
      contributionAmount: Number(updated.contributionAmount),
      rotationModel,
      message: `Tontine activated with ${rotationModel} rotation. First contribution cycle on ${nextPayoutDate.toISOString()}.`,
    });
  } catch (err) { next(err); }
});

router.post("/tontines/:tontineId/members", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: true, message: "userId required" });

    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });
    if (tontine.memberCount >= tontine.maxMembers) {
      return res.status(400).json({ error: true, message: "Tontine is full" });
    }

    const existing = await db.select({ id: tontineMembersTable.id })
      .from(tontineMembersTable)
      .where(and(eq(tontineMembersTable.tontineId, tontineId), eq(tontineMembersTable.userId, userId)));
    if (existing.length > 0) return res.status(409).json({ error: true, message: "User already a member" });

    const nextOrder = tontine.memberCount + 1;
    const [member] = await db.insert(tontineMembersTable).values({
      id: generateId(), tontineId, userId,
      payoutOrder: nextOrder, hasReceivedPayout: 0, contributionsCount: 0,
    }).returning();

    await db.update(tontinesTable).set({
      memberCount: tontine.memberCount + 1,
      totalRounds: tontine.memberCount + 1,
      updatedAt: new Date(),
    }).where(eq(tontinesTable.id, tontineId));

    res.status(201).json(member);
  } catch (err) { next(err); }
});

router.delete("/tontines/:tontineId/members/:userId", async (req, res, next) => {
  try {
    const { tontineId, userId } = req.params;

    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });
    if (tontine.status !== "pending") {
      return res.status(400).json({ error: true, message: "Can only leave a tontine that is still pending" });
    }

    const [member] = await db.select().from(tontineMembersTable)
      .where(and(eq(tontineMembersTable.tontineId, tontineId), eq(tontineMembersTable.userId, userId)));
    if (!member) return res.status(404).json({ error: true, message: "Member not found in this tontine" });
    if (member.contributionsCount > 0) {
      return res.status(400).json({ error: true, message: "Cannot leave a tontine after making contributions" });
    }
    if (tontine.adminUserId === userId) {
      return res.status(400).json({ error: true, message: "Admin cannot leave their own tontine" });
    }

    await db.delete(tontineMembersTable)
      .where(and(eq(tontineMembersTable.tontineId, tontineId), eq(tontineMembersTable.userId, userId)));

    // Recompute payout order for remaining members (close any gaps)
    const remaining = await db.select().from(tontineMembersTable)
      .where(eq(tontineMembersTable.tontineId, tontineId))
      .orderBy(asc(tontineMembersTable.payoutOrder));

    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].payoutOrder !== i + 1) {
        await db.update(tontineMembersTable)
          .set({ payoutOrder: i + 1 })
          .where(eq(tontineMembersTable.id, remaining[i].id));
      }
    }

    const newCount = tontine.memberCount - 1;
    await db.update(tontinesTable).set({
      memberCount: newCount,
      totalRounds: newCount,
      updatedAt: new Date(),
    }).where(eq(tontinesTable.id, tontineId));

    res.json({ success: true, message: "Member removed from tontine", remainingMembers: newCount });
  } catch (err) { next(err); }
});

router.post("/tontines/:tontineId/collect", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const result = await runContributionCycle(tontineId);
    const body = { success: true, ...result };
    await req.saveIdempotentResponse?.(body);
    res.json(body);
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

router.post("/tontines/:tontineId/payout", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const result = await runPayoutCycle(tontineId);
    const body = { success: true, ...result };
    await req.saveIdempotentResponse?.(body);
    res.json(body);
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/tontines/:tontineId/schedule", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });

    const members = await db.select().from(tontineMembersTable)
      .where(eq(tontineMembersTable.tontineId, tontineId))
      .orderBy(tontineMembersTable.payoutOrder);

    const schedule = members.map((m, i) => {
      const payoutDate = new Date(tontine.nextPayoutDate ?? new Date());
      for (let j = 0; j < i; j++) {
        if (tontine.frequency === "weekly")        payoutDate.setDate(payoutDate.getDate() + 7);
        else if (tontine.frequency === "biweekly") payoutDate.setDate(payoutDate.getDate() + 14);
        else payoutDate.setMonth(payoutDate.getMonth() + 1);
      }
      return {
        round: i + 1,
        userId: m.userId,
        payoutOrder: m.payoutOrder,
        scheduledDate: new Date(payoutDate).toISOString(),
        hasReceived: m.hasReceivedPayout === 1,
        contributionsCount: m.contributionsCount,
      };
    });

    res.json({
      tontineId,
      frequency: tontine.frequency,
      contributionAmount: Number(tontine.contributionAmount),
      currency: tontine.currency,
      currentRound: tontine.currentRound,
      totalRounds: tontine.totalRounds,
      nextPayoutDate: tontine.nextPayoutDate,
      schedule,
    });
  } catch (err) { next(err); }
});

router.post("/tontines/:tontineId/bids", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const { userId, bidAmount, desiredPosition } = req.body;
    if (!userId || !bidAmount) return res.status(400).json({ error: true, message: "userId and bidAmount required" });

    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });

    const [bid] = await db.insert(tontineBidsTable).values({
      id: generateId(), tontineId, userId,
      bidAmount: String(bidAmount),
      desiredPosition: desiredPosition ?? 1,
      roundNumber: tontine.currentRound + 1,
    }).returning();

    res.status(201).json({ ...bid, bidAmount: Number(bid.bidAmount) });
  } catch (err) { next(err); }
});

router.get("/tontines/:tontineId/bids", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const bids = await db.select().from(tontineBidsTable)
      .where(eq(tontineBidsTable.tontineId, tontineId))
      .orderBy(desc(tontineBidsTable.bidAmount));
    res.json({ bids: bids.map(b => ({ ...b, bidAmount: Number(b.bidAmount) })) });
  } catch (err) { next(err); }
});

router.post("/tontines/:tontineId/positions/list", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const { sellerId, payoutOrder, askPrice, currency = "XOF", expiresAt } = req.body;
    if (!sellerId || !payoutOrder || !askPrice) {
      return res.status(400).json({ error: true, message: "sellerId, payoutOrder, askPrice required" });
    }
    const listing = await listPositionForSale({
      tontineId, sellerId, payoutOrder: Number(payoutOrder), askPrice: Number(askPrice), currency,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });
    res.status(201).json({ ...listing, askPrice: Number(listing.askPrice) });
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/tontines/:tontineId/positions/market", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const listings = await db.select().from(tontinePositionListingsTable)
      .where(and(
        eq(tontinePositionListingsTable.tontineId, tontineId),
        eq(tontinePositionListingsTable.status, "open"),
      ))
      .orderBy(tontinePositionListingsTable.payoutOrder);
    res.json({ listings: listings.map(l => ({ ...l, askPrice: Number(l.askPrice) })) });
  } catch (err) { next(err); }
});

router.post("/tontines/positions/:listingId/buy", async (req, res, next) => {
  try {
    const { listingId } = req.params;
    const { buyerId } = req.body;
    if (!buyerId) return res.status(400).json({ error: true, message: "buyerId required" });
    await buyTontinePosition(listingId, buyerId);
    res.json({ success: true, message: "Position purchased successfully" });
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/tontines/positions", async (req, res, next) => {
  try {
    const page   = Number(req.query.page)  || 1;
    const limit  = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const listings = await db.select().from(tontinePositionListingsTable)
      .where(eq(tontinePositionListingsTable.status, "open"))
      .orderBy(desc(tontinePositionListingsTable.createdAt))
      .limit(limit).offset(offset);

    const [{ total }] = await db.select({ total: count() })
      .from(tontinePositionListingsTable)
      .where(eq(tontinePositionListingsTable.status, "open"));

    res.json({
      listings: listings.map(l => ({ ...l, askPrice: l.askPrice ? Number(l.askPrice) : null })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) { next(err); }
});

router.get("/reputation/:userId", async (req, res, next) => {
  try {
    const score = await getReputationScore(req.params.userId);
    if (!score) return res.status(404).json({ error: true, message: "No reputation score yet" });
    res.json({
      ...score,
      contributionRate: Number(score.contributionRate),
      repaymentRate:    Number(score.repaymentRate),
    });
  } catch (err) { next(err); }
});

router.post("/reputation/:userId/compute", async (req, res, next) => {
  try {
    const score = await computeReputationScore(req.params.userId);
    res.json({
      ...score,
      contributionRate: Number(score.contributionRate),
      repaymentRate:    Number(score.repaymentRate),
    });
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

// ── Purchase Goals ─────────────────────────────────────────────────────────────

router.post("/tontines/:tontineId/goals", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const { vendorName, vendorPhone, vendorWalletId, goalAmount, goalDescription, releaseCondition, targetDate, votesRequired } = req.body;

    if (!vendorName || !goalAmount || !goalDescription) {
      return res.status(400).json({ error: true, message: "Missing required fields: vendorName, goalAmount, goalDescription" });
    }
    const VALID_CONDITIONS = new Set(["goal_reached", "date_reached", "vote"]);
    if (releaseCondition && !VALID_CONDITIONS.has(releaseCondition)) {
      return res.status(400).json({ error: true, message: "releaseCondition must be: goal_reached | date_reached | vote" });
    }
    if (releaseCondition === "vote" && !votesRequired) {
      return res.status(400).json({ error: true, message: "votesRequired is required when releaseCondition is 'vote'" });
    }

    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });

    const [goal] = await db.insert(tontinePurchaseGoalsTable).values({
      id:               generateId(),
      tontineId,
      vendorName,
      vendorPhone:      vendorPhone     || null,
      vendorWalletId:   vendorWalletId  || null,
      goalAmount:       String(goalAmount),
      goalDescription,
      currentAmount:    "0",
      status:           "open",
      releaseCondition: (releaseCondition || "goal_reached") as any,
      targetDate:       targetDate ? new Date(targetDate) : null,
      votesRequired:    votesRequired ? Number(votesRequired) : null,
      votesReceived:    0,
    }).returning();

    res.status(201).json({ ...goal, goalAmount: Number(goal.goalAmount), currentAmount: Number(goal.currentAmount) });
  } catch (err) { next(err); }
});

router.get("/tontines/:tontineId/goals", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });

    const goals = await db.select().from(tontinePurchaseGoalsTable)
      .where(eq(tontinePurchaseGoalsTable.tontineId, tontineId))
      .orderBy(desc(tontinePurchaseGoalsTable.createdAt));

    res.json(goals.map(g => ({
      ...g,
      goalAmount:    Number(g.goalAmount),
      currentAmount: Number(g.currentAmount),
      progressPct:   Math.min(100, Math.round((Number(g.currentAmount) / Number(g.goalAmount)) * 100)),
    })));
  } catch (err) { next(err); }
});

router.post("/tontines/:tontineId/goals/:goalId/release", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { tontineId, goalId } = req.params;

    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });
    if (!tontine.walletId) return res.status(400).json({ error: true, message: "Tontine has no pool wallet" });

    const [goal] = await db.select().from(tontinePurchaseGoalsTable)
      .where(and(eq(tontinePurchaseGoalsTable.id, goalId), eq(tontinePurchaseGoalsTable.tontineId, tontineId)));
    if (!goal) return res.status(404).json({ error: true, message: "Goal not found" });
    if (goal.status !== "open" && goal.status !== "funded") {
      return res.status(400).json({ error: true, message: `Goal cannot be released — status is '${goal.status}'` });
    }

    // Verify release condition
    const now = new Date();
    if (goal.releaseCondition === "goal_reached") {
      if (Number(goal.currentAmount) < Number(goal.goalAmount)) {
        return res.status(400).json({ error: true, message: "Goal amount not yet reached" });
      }
    } else if (goal.releaseCondition === "date_reached") {
      if (!goal.targetDate || now < goal.targetDate) {
        return res.status(400).json({ error: true, message: "Target date not yet reached" });
      }
    } else if (goal.releaseCondition === "vote") {
      if ((goal.votesReceived ?? 0) < (goal.votesRequired ?? 1)) {
        return res.status(400).json({ error: true, message: `Not enough votes — ${goal.votesReceived}/${goal.votesRequired}` });
      }
    }

    const releaseAmount = Number(goal.goalAmount);

    // ── Vendor resolution: walletId → phone lookup → pending claim ────────────
    let transferId: string | null = null;
    let resolvedWalletId: string | null = goal.vendorWalletId ?? null;

    if (!resolvedWalletId && goal.vendorPhone) {
      // Try to find vendor by phone in users table
      const [vendorUser] = await db.select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.phone, goal.vendorPhone))
        .limit(1);

      if (vendorUser) {
        // Vendor has a KOWRI account — find their primary wallet
        const vendorWallets = await db.select().from(walletsTable)
          .where(and(eq(walletsTable.userId, vendorUser.id), eq(walletsTable.status, "active")));
        const vendorWallet =
          vendorWallets.find(w => w.walletType === "personal") ??
          vendorWallets.find(w => w.walletType !== "tontine") ??
          vendorWallets[0];
        if (vendorWallet) resolvedWalletId = vendorWallet.id;
      }
    }

    if (resolvedWalletId) {
      const result = await processTransfer({
        fromWalletId:   tontine.walletId,
        toWalletId:     resolvedWalletId,
        amount:         releaseAmount,
        currency:       tontine.currency,
        description:    `Tontine project release: ${goal.goalDescription}`,
        skipFraudCheck: true,
      });
      transferId = (result as any)?.transactionId ?? null;
    } else {
      // No known vendor wallet — log a pending claim and simulate SMS invite
      await audit({
        action:   "tontine.goal.pending_vendor_claim",
        entity:   "tontine_purchase_goal",
        entityId: goalId,
        metadata: {
          tontineId,
          vendorName:  goal.vendorName,
          vendorPhone: goal.vendorPhone ?? null,
          amount:      releaseAmount,
          currency:    tontine.currency,
          expiresAt:   new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });

      // Notify tontine admin that funds are pending vendor claim
      await eventBus.publish("tontine.goal.vendor_invite_sent", {
        tontineId,
        goalId,
        vendorName:  goal.vendorName,
        vendorPhone: goal.vendorPhone,
        amount:      releaseAmount,
        currency:    tontine.currency,
        adminUserId: tontine.adminUserId,
      });

      console.log(
        `[GoalRelease] Pending vendor claim: ${goal.vendorName} (${goal.vendorPhone ?? "no phone"})` +
        ` will receive ${releaseAmount} ${tontine.currency} — expires in 30 days`
      );
    }

    const [updated] = await db.update(tontinePurchaseGoalsTable).set({
      status:        "released",
      releasedAt:    now,
      currentAmount: String(releaseAmount),
    }).where(eq(tontinePurchaseGoalsTable.id, goalId)).returning();

    // Notify all tontine members
    const members = await db.select().from(tontineMembersTable).where(eq(tontineMembersTable.tontineId, tontineId));
    await eventBus.publish("tontine.goal.released", {
      tontineId,
      goalId,
      vendorName:   goal.vendorName,
      vendorPhone:  goal.vendorPhone,
      amount:       releaseAmount,
      currency:     tontine.currency,
      memberIds:    members.map(m => m.userId),
      transferId,
    });

    res.json({
      ...updated,
      goalAmount:    Number(updated.goalAmount),
      currentAmount: Number(updated.currentAmount),
      transferId,
      resolvedVendorWalletId: resolvedWalletId,
      pendingVendorPayout: !resolvedWalletId,
      pendingClaimExpiresAt: !resolvedWalletId
        ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
        : null,
    });
  } catch (err) { next(err); }
});

router.post("/tontines/:tontineId/goals/:goalId/vote", async (req, res, next) => {
  try {
    const { tontineId, goalId } = req.params;

    const [goal] = await db.select().from(tontinePurchaseGoalsTable)
      .where(and(eq(tontinePurchaseGoalsTable.id, goalId), eq(tontinePurchaseGoalsTable.tontineId, tontineId)));
    if (!goal) return res.status(404).json({ error: true, message: "Goal not found" });
    if (goal.status !== "open" && goal.status !== "funded") {
      return res.status(400).json({ error: true, message: "Goal is not open for voting" });
    }
    if (goal.releaseCondition !== "vote") {
      return res.status(400).json({ error: true, message: "This goal does not use vote-based release" });
    }

    const newVotes = (goal.votesReceived ?? 0) + 1;
    const [updated] = await db.update(tontinePurchaseGoalsTable)
      .set({ votesReceived: newVotes })
      .where(eq(tontinePurchaseGoalsTable.id, goalId))
      .returning();

    // Auto-release if threshold reached
    if (newVotes >= (goal.votesRequired ?? 1)) {
      const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
      if (tontine?.walletId && goal.vendorWalletId) {
        try {
          await processTransfer({
            fromWalletId:   tontine.walletId,
            toWalletId:     goal.vendorWalletId,
            amount:         Number(goal.goalAmount),
            currency:       tontine.currency,
            description:    `Tontine project release (vote): ${goal.goalDescription}`,
            skipFraudCheck: true,
          });
        } catch { /* non-fatal: funds transfer failed, goal still marked funded */ }
      }
      await db.update(tontinePurchaseGoalsTable).set({
        status:     "released",
        releasedAt: new Date(),
      }).where(eq(tontinePurchaseGoalsTable.id, goalId));

      await eventBus.publish("tontine.goal.released", {
        tontineId, goalId, trigger: "vote",
        vendorName: goal.vendorName, amount: Number(goal.goalAmount),
      });

      return res.json({ ...updated, votesReceived: newVotes, autoReleased: true, message: "Vote threshold reached — funds released" });
    }

    res.json({
      ...updated,
      goalAmount:    Number(updated.goalAmount),
      currentAmount: Number(updated.currentAmount),
      votesReceived: newVotes,
      votesRequired: goal.votesRequired,
      autoReleased:  false,
    });
  } catch (err) { next(err); }
});

// ── Yield & Growth analytics ────────────────────────────────────────────────

router.get("/tontines/:tontineId/yield-summary", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });
    if (tontine.tontineType !== "yield") {
      return res.status(400).json({ error: true, message: "yield-summary is only available for type='yield' tontines" });
    }

    const members = await db
      .select({
        memberId:          tontineMembersTable.id,
        userId:            tontineMembersTable.userId,
        payoutOrder:       tontineMembersTable.payoutOrder,
        hasReceivedPayout: tontineMembersTable.hasReceivedPayout,
        yieldOwed:         tontineMembersTable.yieldOwed,
        yieldPaid:         tontineMembersTable.yieldPaid,
        receivedPayoutAt:  tontineMembersTable.receivedPayoutAt,
        personalContribution: tontineMembersTable.personalContribution,
      })
      .from(tontineMembersTable)
      .where(eq(tontineMembersTable.tontineId, tontineId))
      .orderBy(asc(tontineMembersTable.payoutOrder));

    const yieldRate      = Number(tontine.yieldRate ?? 0);
    const yieldPoolBal   = Number(tontine.yieldPoolBalance ?? 0);
    const defaultAmt     = Number(tontine.contributionAmount);
    const totalRounds    = tontine.totalRounds;
    const currentRound   = tontine.currentRound;

    // Projected payout for each remaining member = basePayout + their share of yield pool
    const remainingMembers = members.filter(m => m.hasReceivedPayout === 0);
    const projectedPayouts = remainingMembers.map((m, idx) => {
      const round          = currentRound + idx + 1;
      const basePayout     = members.reduce((sum, x) => sum + Number(x.personalContribution ?? defaultAmt), 0);
      // Their share of whatever yield pool exists when it's their turn
      const shareCount     = remainingMembers.length - idx;
      const yieldShare     = shareCount > 0 ? yieldPoolBal / shareCount : 0;
      return {
        round,
        userId:              m.userId,
        payoutOrder:         m.payoutOrder,
        basePayout:          Number(basePayout.toFixed(4)),
        projectedYieldShare: Number(yieldShare.toFixed(4)),
        projectedTotal:      Number((basePayout + yieldShare).toFixed(4)),
      };
    });

    res.json({
      tontineId,
      tontineType:      tontine.tontineType,
      yieldRate,
      yieldPoolBalance: yieldPoolBal,
      currentRound,
      totalRounds,
      members: members.map(m => ({
        userId:           m.userId,
        payoutOrder:      m.payoutOrder,
        hasReceivedPayout: m.hasReceivedPayout === 1,
        yieldOwed:        Number(m.yieldOwed ?? 0),
        yieldPaid:        Number(m.yieldPaid ?? 0),
        yieldUnpaid:      Math.max(0, Number(m.yieldOwed ?? 0) - Number(m.yieldPaid ?? 0)),
        receivedPayoutAt: m.receivedPayoutAt,
      })),
      projectedPayouts,
    });
  } catch (err) { next(err); }
});

router.get("/tontines/:tontineId/growth-projection", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });
    if (tontine.tontineType !== "growth") {
      return res.status(400).json({ error: true, message: "growth-projection is only available for type='growth' tontines" });
    }

    const growthRate       = Number(tontine.growthRate ?? 0);
    const currentAmount    = Number(tontine.contributionAmount);
    const remainingRounds  = tontine.totalRounds - tontine.currentRound;
    const requestedN       = Math.min(Number(req.query.n) || remainingRounds, 100);

    const projections: Array<{ round: number; contributionAmount: number; cumulativeIncrease: number }> = [];
    let amt = currentAmount;
    for (let i = 1; i <= requestedN; i++) {
      amt = amt * (1 + growthRate / 100);
      projections.push({
        round:              tontine.currentRound + i,
        contributionAmount: Number(amt.toFixed(4)),
        cumulativeIncrease: Number((amt - currentAmount).toFixed(4)),
      });
    }

    res.json({
      tontineId,
      tontineType:              tontine.tontineType,
      growthRate,
      currentRound:             tontine.currentRound,
      totalRounds:              tontine.totalRounds,
      currentContributionAmount: currentAmount,
      projections,
      totalFundedIfAllRounds:   Number(projections.reduce((s, p) => s + p.contributionAmount, 0).toFixed(4)),
    });
  } catch (err) { next(err); }
});

// ── Hybrid Tontine ──────────────────────────────────────────────────────────

router.post("/tontines/:tontineId/hybrid-config", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const { rotation_pct, investment_pct, solidarity_pct, yield_pct, rebalance_each_cycle = true } = req.body;

    if (rotation_pct == null || investment_pct == null || solidarity_pct == null || yield_pct == null) {
      return res.status(400).json({ error: true, message: "rotation_pct, investment_pct, solidarity_pct, yield_pct all required" });
    }

    const total = Number(rotation_pct) + Number(investment_pct) + Number(solidarity_pct) + Number(yield_pct);
    if (Math.abs(total - 100) > 0.01) {
      return res.status(400).json({ error: true, message: `Percentages must sum to 100, got ${total.toFixed(2)}` });
    }

    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });
    if (tontine.status !== "pending") {
      return res.status(400).json({ error: true, message: "hybrid_config can only be set on pending tontines" });
    }

    const hybridConfig = { rotation_pct: Number(rotation_pct), investment_pct: Number(investment_pct), solidarity_pct: Number(solidarity_pct), yield_pct: Number(yield_pct), rebalance_each_cycle };

    const [updated] = await db.update(tontinesTable).set({
      hybridConfig,
      tontineType: "hybrid",
      updatedAt:   new Date(),
    }).where(eq(tontinesTable.id, tontineId)).returning();

    await eventBus.publish("tontine.hybrid.config_set", { tontineId, hybridConfig });

    res.json({
      tontineId,
      hybridConfig,
      message: "Hybrid configuration saved. The tontine type has been set to 'hybrid'.",
    });
  } catch (err) { next(err); }
});

router.get("/tontines/:tontineId/hybrid-summary", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });

    const cycles = await db.select().from(tontineHybridCyclesTable)
      .where(eq(tontineHybridCyclesTable.tontineId, tontineId))
      .orderBy(desc(tontineHybridCyclesTable.round));

    const lastCycle = cycles[0] ?? null;

    const totalRotation   = cycles.reduce((s, c) => s + Number(c.rotationAmount),   0);
    const totalInvestment = cycles.reduce((s, c) => s + Number(c.investmentAmount), 0);
    const totalYield      = cycles.reduce((s, c) => s + Number(c.yieldAmount),      0);
    const totalSolidarity = cycles.reduce((s, c) => s + Number(c.solidarityAmount), 0);

    // Solidarity reserve = current balance on tontine record
    const solidarityReserve = Number(tontine.solidarityReserve ?? 0);

    res.json({
      tontineId,
      hybridConfig:     tontine.hybridConfig,
      cycleCount:       cycles.length,
      currentRound:     tontine.currentRound,
      totalRounds:      tontine.totalRounds,
      solidarityReserveBalance: solidarityReserve,
      cumulative: {
        rotationDistributed:   totalRotation,
        investmentDeployed:    totalInvestment,
        yieldDistributed:      totalYield,
        solidarityAccrued:     totalSolidarity,
      },
      lastCycle: lastCycle ? {
        round:            lastCycle.round,
        totalPool:        Number(lastCycle.totalPool),
        rotationAmount:   Number(lastCycle.rotationAmount),
        investmentAmount: Number(lastCycle.investmentAmount),
        solidarityAmount: Number(lastCycle.solidarityAmount),
        yieldAmount:      Number(lastCycle.yieldAmount),
        recipientUserId:  lastCycle.recipientUserId,
        yieldRecipients:  lastCycle.yieldRecipients,
        executedAt:       lastCycle.createdAt,
      } : null,
    });
  } catch (err) { next(err); }
});

router.post("/tontines/:tontineId/solidarity-claim", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const { amount, reason, urgency = "low" } = req.body;
    const userId = (req as any).auth?.userId;

    if (!amount || !reason) {
      return res.status(400).json({ error: true, message: "amount and reason are required" });
    }
    if (!["low", "medium", "high"].includes(urgency)) {
      return res.status(400).json({ error: true, message: "urgency must be 'low', 'medium', or 'high'" });
    }

    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });

    const [membership] = await db.select().from(tontineMembersTable)
      .where(and(eq(tontineMembersTable.tontineId, tontineId), eq(tontineMembersTable.userId, userId ?? "")));
    if (!membership && userId) {
      return res.status(403).json({ error: true, message: "You are not a member of this tontine" });
    }

    const reserve    = Number(tontine.solidarityReserve ?? 0);
    const memberCount = Math.max(1, tontine.memberCount);
    const claimAmt   = Number(amount);

    // Auto-approve rules: urgency='high' AND amount <= reserve / member count
    const autoApprove = urgency === "high" && claimAmt <= (reserve / memberCount);
    let claimStatus: "pending_admin" | "approved" | "disbursed" = autoApprove ? "approved" : "pending_admin";

    const [claim] = await db.insert(tontineSolidaryClaimsTable).values({
      id:          generateId(),
      tontineId,
      userId:      userId ?? "anonymous",
      amount:      String(claimAmt),
      reason,
      urgency:     urgency as "low" | "medium" | "high",
      status:      claimStatus,
      autoApproved:autoApprove,
    }).returning();

    // If auto-approved, disburse immediately from pool wallet
    if (autoApprove && tontine.walletId) {
      const memberWallets = await db.select().from(walletsTable)
        .where(and(eq(walletsTable.userId, userId ?? ""), eq(walletsTable.status, "active")));
      const memberWallet = memberWallets.find(w => w.walletType === "personal") ?? memberWallets[0];

      if (memberWallet && memberWallet.id !== tontine.walletId && reserve >= claimAmt) {
        await processTransfer({
          fromWalletId: tontine.walletId,
          toWalletId:   memberWallet.id,
          amount:       claimAmt,
          currency:     tontine.currency,
          description:  `Solidarity emergency claim – ${reason}`,
          skipFraudCheck: true,
        });
        const newReserve = Math.max(0, reserve - claimAmt);
        await db.update(tontinesTable)
          .set({ solidarityReserve: String(newReserve.toFixed(4)), updatedAt: new Date() })
          .where(eq(tontinesTable.id, tontineId));
        await db.update(tontineSolidaryClaimsTable)
          .set({ status: "disbursed", disbursedAt: new Date() })
          .where(eq(tontineSolidaryClaimsTable.id, claim.id));
        claimStatus = "disbursed";
      }
    }

    await eventBus.publish("tontine.solidarity.claim_created", {
      tontineId, claimId: claim.id, userId: claim.userId,
      amount: claimAmt, urgency, autoApprove, status: claimStatus,
    });

    res.status(201).json({
      claimId:       claim.id,
      status:        claimStatus,
      autoApproved:  autoApprove,
      amount:        claimAmt,
      urgency,
      reason,
      reserveBalance:Number(tontine.solidarityReserve ?? 0),
      message:       autoApprove
        ? "Emergency claim auto-approved and disbursed immediately"
        : "Claim submitted for admin review",
    });
  } catch (err) { next(err); }
});

// ── Strategy Tontine ────────────────────────────────────────────────────────

router.post("/tontines/:tontineId/strategy/targets", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const { merchantId, allocatedAmount, purpose } = req.body;
    if (!merchantId || !allocatedAmount || !purpose) {
      return res.status(400).json({ error: true, message: "merchantId, allocatedAmount, purpose required" });
    }

    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });

    const [merchant] = await db.select().from(merchantsTable).where(eq(merchantsTable.id, merchantId));
    if (!merchant) return res.status(404).json({ error: true, message: "Merchant not found" });

    const [target] = await db.insert(tontineStrategyTargetsTable).values({
      id: generateId(),
      tontineId,
      merchantId,
      allocatedAmount: String(allocatedAmount),
      purpose,
      status: "funded",
    }).returning();

    await eventBus.publish("tontine.strategy.target_added", {
      tontineId, targetId: target.id, merchantId, allocatedAmount, purpose,
    });

    res.status(201).json({ target, merchant: { id: merchant.id, businessName: merchant.businessName } });
  } catch (err) { next(err); }
});

router.get("/tontines/:tontineId/strategy/targets", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });

    const targets = await db.select().from(tontineStrategyTargetsTable)
      .where(eq(tontineStrategyTargetsTable.tontineId, tontineId));

    const enriched = await Promise.all(targets.map(async (t) => {
      const [merchant] = await db.select({
        id: merchantsTable.id, businessName: merchantsTable.businessName,
        walletId: merchantsTable.walletId, totalRevenue: merchantsTable.totalRevenue,
      }).from(merchantsTable).where(eq(merchantsTable.id, t.merchantId));
      return { ...t, merchant: merchant ?? null };
    }));

    res.json({
      tontineId, strategyMode: tontine.strategyMode, strategyZone: tontine.strategyZone,
      strategyObjective: tontine.strategyObjective,
      targetCount: enriched.length,
      totalAllocated: enriched.reduce((s, t) => s + Number(t.allocatedAmount), 0),
      targets: enriched,
    });
  } catch (err) { next(err); }
});

router.post("/tontines/:tontineId/strategy/distribute", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });
    if (!tontine.strategyMode) {
      return res.status(400).json({ error: true, message: "This tontine is not in strategy mode. Set strategy_mode=true first." });
    }

    const { distributeToTargets: distribute } = await import("../lib/tontineScheduler");
    const result = await distribute(tontineId);

    res.json({
      success: true,
      tontineId,
      distributed:      result.distributed,
      totalDistributed: result.totalDistributed,
      failed:           result.failed,
    });
  } catch (err: any) { res.status(500).json({ error: true, message: err.message }); }
});

router.get("/tontines/:tontineId/strategy/performance", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });

    const targets = await db.select().from(tontineStrategyTargetsTable)
      .where(eq(tontineStrategyTargetsTable.tontineId, tontineId));

    if (!targets.length) {
      return res.json({ tontineId, totalRevenue: 0, roi: 0, targetCount: 0, targets: [] });
    }

    const totalAllocated    = targets.reduce((s, t) => s + Number(t.allocatedAmount), 0);
    const totalRevenue      = targets.reduce((s, t) => s + Number(t.revenueGenerated), 0);
    const roi               = totalAllocated > 0 ? ((totalRevenue - totalAllocated) / totalAllocated) * 100 : 0;

    const sorted        = [...targets].sort((a, b) => Number(b.performanceScore) - Number(a.performanceScore));
    const bestPerformer  = sorted[0];
    const worstPerformer = sorted[sorted.length - 1];

    const enriched = await Promise.all(sorted.map(async (t) => {
      const [m] = await db.select({ businessName: merchantsTable.businessName })
        .from(merchantsTable).where(eq(merchantsTable.id, t.merchantId));
      return {
        targetId:        t.id,
        merchantId:      t.merchantId,
        businessName:    m?.businessName ?? "Unknown",
        allocatedAmount: Number(t.allocatedAmount),
        revenueGenerated:Number(t.revenueGenerated),
        performanceScore:Number(t.performanceScore),
        status:          t.status,
        roi:             Number(t.allocatedAmount) > 0
          ? ((Number(t.revenueGenerated) - Number(t.allocatedAmount)) / Number(t.allocatedAmount)) * 100 : 0,
      };
    }));

    res.json({
      tontineId,
      strategyZone:      tontine.strategyZone,
      strategyObjective: tontine.strategyObjective,
      summary: {
        targetCount:      targets.length,
        activeTargets:    targets.filter(t => t.status === "active").length,
        totalAllocated,
        totalRevenue,
        roi:              Number(roi.toFixed(2)),
        netGain:          totalRevenue - totalAllocated,
      },
      bestPerformer: enriched[0] ? { merchantId: enriched[0].merchantId, businessName: enriched[0].businessName, performanceScore: enriched[0].performanceScore } : null,
      worstPerformer: enriched[enriched.length - 1] ? { merchantId: enriched[enriched.length - 1].merchantId, businessName: enriched[enriched.length - 1].businessName, performanceScore: enriched[enriched.length - 1].performanceScore } : null,
      targets: enriched,
    });
  } catch (err) { next(err); }
});

// ── AI Priority Assessment ──────────────────────────────────────────────────

router.post("/tontines/:tontineId/ai-assess", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });

    const ranked = await computeTontineAIPriority(tontineId);

    res.json({
      tontineId,
      assessedAt: new Date(),
      memberCount: ranked.length,
      rankedMembers: ranked.map(a => ({
        rank:           a.rank,
        userId:         a.userId,
        priorityScore:  Number(a.priorityScore),
        recommendation: a.recommendation,
        factors:        a.factors,
      })),
    });
  } catch (err: any) { res.status(500).json({ error: true, message: err.message }); }
});

router.get("/tontines/:tontineId/ai-assessment", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });

    const assessments = await db.select().from(tontineAiAssessmentsTable)
      .where(eq(tontineAiAssessmentsTable.tontineId, tontineId))
      .orderBy(desc(tontineAiAssessmentsTable.priorityScore));

    if (assessments.length === 0) {
      return res.status(404).json({ error: true, message: "No AI assessment found — run POST /ai-assess first" });
    }

    res.json({
      tontineId,
      applied:    assessments.some(a => a.applied),
      assessedAt: assessments[0].assessedAt,
      rankedMembers: assessments.map((a, i) => ({
        rank:           i + 1,
        userId:         a.userId,
        priorityScore:  Number(a.priorityScore),
        recommendation: a.recommendation,
        factors:        a.factors,
        applied:        a.applied,
      })),
    });
  } catch (err) { next(err); }
});

router.post("/tontines/:tontineId/apply-ai-order", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const { adminOverride = false } = req.body;

    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) return res.status(404).json({ error: true, message: "Tontine not found" });

    if (tontine.status !== "pending" && !adminOverride) {
      return res.status(400).json({ error: true, message: "AI order can only be applied to pending tontines. Pass adminOverride=true to force." });
    }

    const assessments = await db.select().from(tontineAiAssessmentsTable)
      .where(eq(tontineAiAssessmentsTable.tontineId, tontineId))
      .orderBy(desc(tontineAiAssessmentsTable.priorityScore));

    if (assessments.length === 0) {
      return res.status(400).json({ error: true, message: "No AI assessment found — run POST /ai-assess first" });
    }

    // Apply ranked order: highest priority_score → payoutOrder 1 (receives first)
    const updates: Array<{ userId: string; newOrder: number; priorityScore: number }> = [];
    for (let i = 0; i < assessments.length; i++) {
      const newOrder = i + 1;
      await db.update(tontineMembersTable)
        .set({ payoutOrder: newOrder })
        .where(and(
          eq(tontineMembersTable.tontineId, tontineId),
          eq(tontineMembersTable.userId, assessments[i].userId),
        ));
      await db.update(tontineAiAssessmentsTable)
        .set({ applied: true })
        .where(eq(tontineAiAssessmentsTable.id, assessments[i].id));
      updates.push({ userId: assessments[i].userId, newOrder, priorityScore: Number(assessments[i].priorityScore) });
    }

    await eventBus.publish("tontine.ai.order_applied", { tontineId, updatedMembers: updates.length, adminOverride });

    res.json({
      success: true,
      tontineId,
      message:  `AI payout order applied to ${updates.length} members`,
      appliedOrder: updates,
    });
  } catch (err) { next(err); }
});

// ── Reputation Badges ───────────────────────────────────────────────────────

router.get("/reputation/:userId/badges", async (req, res, next) => {
  try {
    const { userId } = req.params;
    const [rep] = await db.select().from(reputationScoresTable).where(eq(reputationScoresTable.userId, userId));
    if (!rep) {
      return res.status(404).json({ error: true, message: "No reputation score found. Run POST /reputation/:userId/compute first." });
    }

    const badges = rep.badges ?? [];
    const BADGE_META: Record<string, { label: string; description: string }> = {
      reliable_contributor: { label: "Contributeur Fiable",   description: "Zéro paiement manqué sur 5+ cycles de tontine" },
      trusted_organizer:    { label: "Organisateur Reconnu",  description: "A créé et complété 3+ tontines en tant qu'admin" },
      fast_repayer:         { label: "Rembourseur Rapide",    description: "Tous les prêts remboursés à temps (3+ prêts)" },
      community_champion:   { label: "Champion Communautaire",description: "Top 10% du score de réputation sur la plateforme" },
      diaspora_connector:   { label: "Connecteur Diaspora",   description: "Participation à une tontine multi-pays" },
    };

    res.json({
      userId,
      score:      rep.score,
      tier:       rep.tier,
      badgeCount: badges.length,
      badges: badges.map(b => ({
        ...b,
        ...(BADGE_META[b.badge] ?? { label: b.badge, description: b.criteria }),
      })),
      availableBadges: Object.entries(BADGE_META)
        .filter(([key]) => !badges.some(b => b.badge === key))
        .map(([key, meta]) => ({ badge: key, ...meta, earned: false })),
    });
  } catch (err) { next(err); }
});

router.get("/scheduler/jobs", async (req, res, next) => {
  try {
    const jobs = await db.select().from(schedulerJobsTable)
      .orderBy(desc(schedulerJobsTable.scheduledAt))
      .limit(50);
    const [{ total }] = await db.select({ total: count() }).from(schedulerJobsTable);
    res.json({ jobs, total: Number(total) });
  } catch (err) { next(err); }
});

export default router;
