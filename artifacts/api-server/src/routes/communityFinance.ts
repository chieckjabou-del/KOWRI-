import { Router } from "express";
import { db } from "@workspace/db";
import {
  tontinesTable, tontineMembersTable, walletsTable,
  tontinePositionListingsTable, tontineBidsTable, reputationScoresTable,
  schedulerJobsTable,
} from "@workspace/db";
import { eq, and, desc, count } from "drizzle-orm";
import { generateId } from "../lib/id";
import {
  runContributionCycle, runPayoutCycle, assignPayoutOrder,
  listPositionForSale, buyTontinePosition, computeNextDate, createSchedulerJob,
} from "../lib/tontineScheduler";
import { computeReputationScore, getReputationScore } from "../lib/reputationEngine";

const router = Router();

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

router.post("/tontines/:tontineId/collect", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const result = await runContributionCycle(tontineId);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

router.post("/tontines/:tontineId/payout", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const result = await runPayoutCycle(tontineId);
    res.json({ success: true, ...result });
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
