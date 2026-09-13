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

import { authenticate, isAdminRequest } from "../middleware/auth";
import { launchModule } from "../middleware/launchScope";
import { routeParamString } from "../lib/routeParams";

const router = Router();

router.use(authenticate());

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

// Declares a community's volume. Only the community's creator (or an
// operator) may declare it, and nothing is credited: see lib/creatorEconomy.ts.
router.post("/communities/:communityId/earnings", launchModule("creator_earnings"), async (req, res, next) => {
  try {
    const communityId = routeParamString(req, "communityId")!;
    const { transactionAmount, currency = "XOF" } = req.body;
    if (!transactionAmount) {
      return res.status(400).json({ error: true, message: "transactionAmount required" });
    }
    const [community] = await db.select({ creatorId: creatorCommunitiesTable.creatorId }).from(creatorCommunitiesTable)
      .where(eq(creatorCommunitiesTable.id, communityId)).limit(1);
    if (!community) return res.status(404).json({ error: true, message: "Community not found" });
    if (!isAdminRequest(req) && community.creatorId !== req.auth!.userId) {
      return res.status(403).json({ error: true, message: "Only the community creator can declare its earnings" });
    }
    const result = await distributeCreatorEarnings(
      communityId, Number(transactionAmount), currency, req.admin?.email ?? req.auth!.userId,
    );
    return res.json({ success: true, ...result });
  } catch (err: any) {
    // Scope and kill-switch refusals keep their 503 semantics.
    if (err?.name === "ModuleDisabledError" || err?.name === "KillSwitchError") return next(err);
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
