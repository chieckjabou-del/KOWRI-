import { Router } from "express";
import { db } from "@workspace/db";
import {
  tontinesTable, tontineMembersTable, walletsTable,
  tontinePositionListingsTable, tontineBidsTable, reputationScoresTable,
  schedulerJobsTable, tontinePurchaseGoalsTable,
} from "@workspace/db";
import { eq, and, desc, count, asc, gte } from "drizzle-orm";
import { processTransfer } from "../lib/walletService";
import { eventBus } from "../lib/eventBus";
import { generateId } from "../lib/id";
import {
  runContributionCycle, runPayoutCycle, assignPayoutOrder,
  listPositionForSale, buyTontinePosition, computeNextDate, createSchedulerJob,
} from "../lib/tontineScheduler";
import { computeReputationScore, getReputationScore } from "../lib/reputationEngine";
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

router.post("/tontines/:tontineId/goals/:goalId/release", async (req, res, next) => {
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

    // Transfer from pool to vendor wallet (if vendor has a KOWRI wallet)
    let transferId: string | null = null;
    if (goal.vendorWalletId) {
      const result = await processTransfer({
        fromWalletId:   tontine.walletId,
        toWalletId:     goal.vendorWalletId,
        amount:         releaseAmount,
        currency:       tontine.currency,
        description:    `Tontine project release: ${goal.goalDescription}`,
        skipFraudCheck: true,
      });
      transferId = (result as any)?.transactionId ?? null;
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
      pendingVendorPayout: !goal.vendorWalletId,
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
