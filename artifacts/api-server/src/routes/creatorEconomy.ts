import { Router } from "express";
import { db } from "@workspace/db";
import { creatorCommunitiesTable } from "@workspace/db";
import { eq, desc, count } from "drizzle-orm";
import {
  createCommunity, getCommunity, listCommunities,
  joinCommunity, distributeCreatorEarnings,
  getCommunityPools, getCreatorDashboard,
} from "../lib/creatorEconomy";
import { requireAuth } from "../lib/productAuth";

const router = Router();

router.use(async (req, res, next) => {
  const auth = await requireAuth(req.headers.authorization);
  if (!auth) {
    return res.status(401).json({ error: true, message: "Unauthorized. Provide a valid Bearer token." });
  }
  return next();
});

router.get("/communities", async (req, res, next) => {
  try {
    const page  = Number(req.query.page)  || 1;
    const limit = Number(req.query.limit) || 20;
    const communities = await listCommunities(page, limit);
    const [{ total }] = await db.select({ total: count() }).from(creatorCommunitiesTable);
    return res.json({
      communities,
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) { return next(err); }
});

router.post("/communities", async (req, res, next) => {
  try {
    const { name, description, creatorId, handle, platformFeeRate, creatorFeeRate } = req.body;
    if (!name || !creatorId || !handle) {
      return res.status(400).json({ error: true, message: "name, creatorId, handle required" });
    }
    const community = await createCommunity({
      name, description, creatorId, handle,
      platformFeeRate: platformFeeRate ? Number(platformFeeRate) : undefined,
      creatorFeeRate:  creatorFeeRate  ? Number(creatorFeeRate)  : undefined,
    });
    return res.status(201).json(community);
  } catch (err: any) {
    if (err.message === "Handle already taken") {
      return res.status(409).json({ error: true, message: err.message });
    }
    return next(err);
  }
});

router.get("/communities/:handleOrId", async (req, res, next) => {
  try {
    const community = await getCommunity(req.params.handleOrId);
    if (!community) return res.status(404).json({ error: true, message: "Community not found" });
    return res.json(community);
  } catch (err) { return next(err); }
});

router.post("/communities/:communityId/join", async (req, res, next) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: true, message: "userId required" });
    await joinCommunity(req.params.communityId, userId);
    return res.json({ success: true, message: "Joined community" });
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/communities/:communityId/pools", async (req, res, next) => {
  try {
    const data = await getCommunityPools(req.params.communityId);
    return res.json(data);
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.post("/communities/:communityId/earnings", async (req, res, next) => {
  try {
    const { transactionAmount, currency = "XOF" } = req.body;
    if (!transactionAmount) {
      return res.status(400).json({ error: true, message: "transactionAmount required" });
    }
    const result = await distributeCreatorEarnings(
      req.params.communityId, Number(transactionAmount), currency,
    );
    return res.json({ success: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.patch("/communities/:communityId/status", async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!["active", "suspended", "closed"].includes(status)) {
      return res.status(400).json({ error: true, message: "status must be active | suspended | closed" });
    }
    const [updated] = await db.update(creatorCommunitiesTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(creatorCommunitiesTable.id, req.params.communityId))
      .returning();
    if (!updated) return res.status(404).json({ error: true, message: "Community not found" });
    return res.json({ ...updated, platformFeeRate: Number(updated.platformFeeRate), creatorFeeRate: Number(updated.creatorFeeRate) });
  } catch (err) { return next(err); }
});

router.get("/dashboard/:creatorId", async (req, res, next) => {
  try {
    const dashboard = await getCreatorDashboard(req.params.creatorId);
    return res.json(dashboard);
  } catch (err) { return next(err); }
});

export default router;
