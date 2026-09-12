import { Router } from "express";
import { db } from "@workspace/db";
import { investmentPoolsTable, poolPositionsTable, walletsTable } from "@workspace/db";
import { eq, and, desc, count } from "drizzle-orm";
import { generateId } from "../lib/id";
import {
  createInvestmentPool, investInPool,
  distributePoolReturns, redeemPoolPosition,
} from "../lib/communityFinance";
import { authenticate, isAdminRequest, walletBelongsToUser } from "../middleware/auth";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";
import { routeParamString } from "../lib/routeParams";

const router = Router();

router.use(authenticate());

router.get("/", async (req, res, next) => {
  try {
    const page   = Number(req.query.page)   || 1;
    const limit  = Number(req.query.limit)  || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;
    const type   = req.query.type   as string | undefined;

    const rows = await db.select().from(investmentPoolsTable)
      .where(and(
        status ? eq(investmentPoolsTable.status, status as any) : undefined,
        type   ? eq(investmentPoolsTable.poolType, type)        : undefined,
      ))
      .orderBy(desc(investmentPoolsTable.createdAt))
      .limit(limit).offset(offset);

    const [{ total }] = await db.select({ total: count() }).from(investmentPoolsTable);

    return res.json({
      pools: rows.map(p => ({
        ...p,
        goalAmount:    Number(p.goalAmount),
        currentAmount: Number(p.currentAmount),
        minInvestment: Number(p.minInvestment),
        expectedReturn: Number(p.expectedReturn),
        totalShares:   Number(p.totalShares),
        nav:           Number(p.totalShares) > 0
          ? Number(p.currentAmount) / Number(p.totalShares)
          : 1,
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) { return next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, description, poolType = "general", currency = "XOF",
            goalAmount, minInvestment = 1000, expectedReturn = 0, closingDate, maturityDate } = req.body;
    const managerId = req.auth!.userId;

    if (!name || !goalAmount) {
      return res.status(400).json({ error: true, message: "name, goalAmount required" });
    }

    const poolWalletId = generateId();
    await db.insert(walletsTable).values({
      id: poolWalletId, userId: managerId, currency,
      balance: "0", availableBalance: "0", status: "active", walletType: "savings",
      createdAt: new Date(), updatedAt: new Date(),
    });

    const pool = await createInvestmentPool({
      name, description, poolType, managerId,
      poolWalletId, goalAmount: Number(goalAmount), currency,
      minInvestment: Number(minInvestment), expectedReturn: Number(expectedReturn),
      closingDate: closingDate ? new Date(closingDate) : undefined,
      maturityDate: maturityDate ? new Date(maturityDate) : undefined,
    });

    return res.status(201).json({
      ...pool,
      goalAmount:    Number(pool.goalAmount),
      currentAmount: Number(pool.currentAmount),
      minInvestment: Number(pool.minInvestment),
      expectedReturn: Number(pool.expectedReturn),
    });
  } catch (err) { return next(err); }
});

router.get("/:poolId", async (req, res, next) => {
  try {
    const poolId = routeParamString(req, "poolId")!;
    const [pool] = await db.select().from(investmentPoolsTable)
      .where(eq(investmentPoolsTable.id, poolId));
    if (!pool) return res.status(404).json({ error: true, message: "Pool not found" });

    const positions = await db.select().from(poolPositionsTable)
      .where(eq(poolPositionsTable.poolId, poolId));

    const totalShares = Number(pool.totalShares);
    const viewerId = req.auth!.userId;
    const canSeeAll = isAdminRequest(req) || pool.managerId === viewerId;
    return res.json({
      ...pool,
      goalAmount:    Number(pool.goalAmount),
      currentAmount: Number(pool.currentAmount),
      minInvestment: Number(pool.minInvestment),
      expectedReturn: Number(pool.expectedReturn),
      totalShares,
      nav: totalShares > 0 ? Number(pool.currentAmount) / totalShares : 1,
      investorCount: positions.length,
      positions: positions
        .filter(p => canSeeAll || p.userId === viewerId)
        .map(p => ({
          ...p,
          investedAmount: Number(p.investedAmount),
          shares:        Number(p.shares),
          returnAmount:  Number(p.returnAmount),
        })),
    });
  } catch (err) { return next(err); }
});

router.post("/:poolId/invest", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { fromWalletId, amount } = req.body;
    const userId = req.auth!.userId;
    if (!fromWalletId || !amount) {
      return res.status(400).json({ error: true, message: "fromWalletId, amount required" });
    }
    if (!(await walletBelongsToUser(String(fromWalletId), userId))) {
      return res.status(403).json({ error: true, message: "You do not own the source wallet" });
    }
    const position = await investInPool({
      poolId: routeParamString(req, "poolId")!, userId,
      fromWalletId, amount: Number(amount),
    });
    return res.status(201).json({
      ...position,
      investedAmount: Number(position.investedAmount),
      shares:        Number(position.shares),
      returnAmount:  Number(position.returnAmount),
    });
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.post("/:poolId/distribute", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { totalReturn } = req.body;
    if (!totalReturn) return res.status(400).json({ error: true, message: "totalReturn required" });
    const distributed = await distributePoolReturns(
      routeParamString(req, "poolId")!,
      Number(totalReturn),
      { userId: req.auth!.userId, isPlatformAdmin: isAdminRequest(req) },
    );
    return res.json({ success: true, distributed });
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.post("/positions/:positionId/redeem", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    await redeemPoolPosition(routeParamString(req, "positionId")!, req.auth!.userId);
    return res.json({ success: true, message: "Position redeemed successfully" });
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err.message });
  }
});

router.get("/:poolId/nav", async (req, res, next) => {
  try {
    const poolId = routeParamString(req, "poolId")!;
    const [pool] = await db.select().from(investmentPoolsTable)
      .where(eq(investmentPoolsTable.id, poolId));
    if (!pool) return res.status(404).json({ error: true, message: "Pool not found" });

    const totalShares   = Number(pool.totalShares);
    const currentAmount = Number(pool.currentAmount);
    const nav = totalShares > 0 ? currentAmount / totalShares : 1;

    return res.json({
      poolId:        pool.id,
      nav,
      currentAmount,
      totalShares,
      currency:      pool.currency,
      computedAt:    new Date().toISOString(),
    });
  } catch (err) { return next(err); }
});

export default router;
