import { Router } from "express";
import { db } from "@workspace/db";
import {
  insurancePoolsTable, insurancePoliciesTable, insuranceClaimsTable, walletsTable,
} from "@workspace/db";
import { eq, and, desc, count } from "drizzle-orm";
import { generateId } from "../lib/id";
import {
  createInsurancePool, joinInsurancePool, fileClaim, adjudicateClaim,
} from "../lib/communityFinance";
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

router.get("/", async (req, res, next) => {
  try {
    const page   = Number(req.query.page)  || 1;
    const limit  = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const type   = req.query.type as string | undefined;

    const rows = await db.select().from(insurancePoolsTable)
      .where(type ? eq(insurancePoolsTable.insuranceType, type) : undefined)
      .orderBy(desc(insurancePoolsTable.createdAt))
      .limit(limit).offset(offset);

    const [{ total }] = await db.select({ total: count() }).from(insurancePoolsTable);

    res.json({
      pools: rows.map(p => ({
        ...p,
        premiumAmount: Number(p.premiumAmount),
        claimLimit:    Number(p.claimLimit),
        reserveRatio:  Number(p.reserveRatio),
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const {
      name, description, insuranceType = "general", managerId,
      premiumAmount, premiumFreq = "monthly", claimLimit,
      currency = "XOF", maxMembers = 100,
    } = req.body;

    if (!name || !managerId || !premiumAmount || !claimLimit) {
      return res.status(400).json({ error: true, message: "name, managerId, premiumAmount, claimLimit required" });
    }

    const poolWalletId = generateId();
    await db.insert(walletsTable).values({
      id: poolWalletId, userId: managerId, currency,
      balance: "0", availableBalance: "0", status: "active", walletType: "savings",
      createdAt: new Date(), updatedAt: new Date(),
    });

    const pool = await createInsurancePool({
      name, description, insuranceType, managerId,
      poolWalletId, premiumAmount: Number(premiumAmount), premiumFreq,
      claimLimit: Number(claimLimit), currency, maxMembers: Number(maxMembers),
    });

    res.status(201).json({
      ...pool,
      premiumAmount: Number(pool.premiumAmount),
      claimLimit:    Number(pool.claimLimit),
      reserveRatio:  Number(pool.reserveRatio),
    });
  } catch (err) { next(err); }
});

router.get("/:poolId", async (req, res, next) => {
  try {
    const [pool] = await db.select().from(insurancePoolsTable)
      .where(eq(insurancePoolsTable.id, req.params.poolId));
    if (!pool) return res.status(404).json({ error: true, message: "Insurance pool not found" });

    const [{ claimCount }] = await db.select({ claimCount: count() })
      .from(insuranceClaimsTable)
      .where(eq(insuranceClaimsTable.poolId, req.params.poolId));

    res.json({
      ...pool,
      premiumAmount: Number(pool.premiumAmount),
      claimLimit:    Number(pool.claimLimit),
      reserveRatio:  Number(pool.reserveRatio),
      claimCount:    Number(claimCount),
    });
  } catch (err) { next(err); }
});

router.post("/:poolId/join", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { userId, walletId } = req.body;
    if (!userId || !walletId) {
      return res.status(400).json({ error: true, message: "userId and walletId required" });
    }
    const policy = await joinInsurancePool(req.params.poolId, userId, walletId);
    const body = { ...policy, totalPremiumPaid: Number(policy.totalPremiumPaid) };
    await req.saveIdempotentResponse?.(body);
    res.status(201).json(body);
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/:poolId/policies", async (req, res, next) => {
  try {
    const policies = await db.select().from(insurancePoliciesTable)
      .where(eq(insurancePoliciesTable.poolId, req.params.poolId))
      .orderBy(desc(insurancePoliciesTable.createdAt));
    res.json({
      policies: policies.map(p => ({
        ...p, totalPremiumPaid: Number(p.totalPremiumPaid),
      })),
    });
  } catch (err) { next(err); }
});

router.post("/:poolId/claims", async (req, res, next) => {
  try {
    const { policyId, userId, claimAmount, reason, evidenceUrl } = req.body;
    if (!policyId || !userId || !claimAmount || !reason) {
      return res.status(400).json({ error: true, message: "policyId, userId, claimAmount, reason required" });
    }
    const claim = await fileClaim({
      policyId, poolId: req.params.poolId, userId,
      claimAmount: Number(claimAmount), reason, evidenceUrl,
    });
    res.status(201).json({ ...claim, claimAmount: Number(claim.claimAmount) });
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/:poolId/claims", async (req, res, next) => {
  try {
    const status = req.query.status as string | undefined;
    const claims = await db.select().from(insuranceClaimsTable)
      .where(and(
        eq(insuranceClaimsTable.poolId, req.params.poolId),
        status ? eq(insuranceClaimsTable.status, status as any) : undefined,
      ))
      .orderBy(desc(insuranceClaimsTable.createdAt));
    res.json({
      claims: claims.map(c => ({
        ...c,
        claimAmount:  Number(c.claimAmount),
        payoutAmount: c.payoutAmount ? Number(c.payoutAmount) : null,
      })),
    });
  } catch (err) { next(err); }
});

router.patch("/claims/:claimId/adjudicate", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { adjudicatorId, approved, payoutAmount, rejectionReason } = req.body;
    if (!adjudicatorId || approved === undefined) {
      return res.status(400).json({ error: true, message: "adjudicatorId and approved required" });
    }
    await adjudicateClaim(req.params.claimId, adjudicatorId, Boolean(approved), payoutAmount, rejectionReason);
    const body = { success: true, approved: Boolean(approved) };
    await req.saveIdempotentResponse?.(body);
    res.json(body);
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

export default router;
