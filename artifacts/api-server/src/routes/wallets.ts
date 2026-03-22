import { Router } from "express";
import { db } from "@workspace/db";
import { walletsTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";
import { generateId, generateReference } from "../lib/id";
import { getWalletBalance } from "../lib/walletService";
import { processDeposit, processTransfer } from "../lib/walletService";
import { validatePagination, validateQueryParams, VALID_CURRENCIES } from "../middleware/validate";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";
import { audit } from "../lib/auditLogger";
import { requireAuth } from "../lib/productAuth";

const router = Router();

router.use(async (req, res, next) => {
  const auth = await requireAuth(req.headers.authorization);
  if (!auth) {
    res.status(401).json({ error: true, message: "Unauthorized. Provide a valid Bearer token." });
    return;
  }
  next();
});

router.get(
  "/",
  validatePagination,
  validateQueryParams({ currency: VALID_CURRENCIES }),
  async (req, res, next) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const offset = (page - 1) * limit;
      const userId = req.query.userId as string | undefined;
      const currency = req.query.currency as string | undefined;

      const conditions: any[] = [];
      if (userId) conditions.push(eq(walletsTable.userId, userId));
      if (currency) conditions.push(eq(walletsTable.currency, currency));

      const whereClause =
        conditions.length > 0
          ? sql`${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
          : undefined;

      const [wallets, [{ total }]] = await Promise.all([
        db.select().from(walletsTable).where(whereClause).limit(limit).offset(offset).orderBy(sql`${walletsTable.createdAt} DESC`),
        db.select({ total: count() }).from(walletsTable).where(whereClause),
      ]);

      res.json({
        wallets: wallets.map((w) => ({
          ...w,
          balance: Number(w.balance),
          availableBalance: Number(w.availableBalance),
        })),
        pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post("/", async (req, res, next) => {
  try {
    const { userId, currency, walletType } = req.body;
    if (!userId || !currency || !walletType) {
      res.status(400).json({ error: true, message: "Missing required fields: userId, currency, walletType" });
      return;
    }
    if (!VALID_CURRENCIES.has(currency)) {
      res.status(400).json({ error: true, message: `Invalid currency. Must be one of: ${[...VALID_CURRENCIES].join(", ")}` });
      return;
    }

    const [wallet] = await db
      .insert(walletsTable)
      .values({ id: generateId(), userId, currency, walletType, balance: "0", availableBalance: "0", status: "active" })
      .returning();

    res.status(201).json({ ...wallet, balance: 0, availableBalance: 0 });
  } catch (err) {
    next(err);
  }
});

router.get("/:walletId", async (req, res, next) => {
  try {
    const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, req.params.walletId));
    if (!wallet) {
      res.status(404).json({ error: true, message: "Wallet not found" });
      return;
    }
    const derivedBalance = await getWalletBalance(req.params.walletId);
    res.json({ ...wallet, balance: derivedBalance, availableBalance: derivedBalance, balanceSource: "ledger" });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/:walletId/deposit",
  requireIdempotencyKey,
  checkIdempotency,
  async (req, res, next) => {
    try {
      const { walletId } = req.params;
      const { amount, currency, reference, description } = req.body;

      if (!amount || Number(amount) <= 0 || !currency) {
        res.status(400).json({ error: true, message: "Invalid deposit: amount (>0) and currency are required" });
        return;
      }
      if (!VALID_CURRENCIES.has(currency)) {
        res.status(400).json({ error: true, message: `Invalid currency. Must be one of: ${[...VALID_CURRENCIES].join(", ")}` });
        return;
      }

      const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, walletId));
      if (!wallet) {
        res.status(404).json({ error: true, message: "Wallet not found" });
        return;
      }

      const tx = await processDeposit({
        walletId,
        amount: Number(amount),
        currency,
        reference: reference ?? generateReference(),
        description,
        idempotencyKey: req.idempotencyKey,
      });

      const body = { ...tx, amount: Number(tx.amount) };
      await req.saveIdempotentResponse?.(body);
      res.json(body);
    } catch (err: any) {
      if (err.message === "Wallet not found") {
        res.status(404).json({ error: true, message: "Wallet not found" });
        return;
      }
      next(err);
    }
  }
);

router.post(
  "/:walletId/transfer",
  requireIdempotencyKey,
  checkIdempotency,
  async (req, res, next) => {
    try {
      const { walletId } = req.params;
      const { toWalletId, amount, currency, description, reference } = req.body;

      if (!toWalletId || !amount || Number(amount) <= 0 || !currency) {
        res.status(400).json({ error: true, message: "Invalid transfer: toWalletId, amount (>0), and currency are required" });
        return;
      }
      if (!VALID_CURRENCIES.has(currency)) {
        res.status(400).json({ error: true, message: `Invalid currency. Must be one of: ${[...VALID_CURRENCIES].join(", ")}` });
        return;
      }
      if (walletId === toWalletId) {
        res.status(400).json({ error: true, message: "Source and destination wallets must be different" });
        return;
      }

      const tx = await processTransfer({
        fromWalletId: walletId,
        toWalletId,
        amount: Number(amount),
        currency,
        description,
        reference,
        idempotencyKey: req.idempotencyKey,
      });

      const body = { ...tx, amount: Number(tx.amount) };
      await req.saveIdempotentResponse?.(body);
      res.json(body);
    } catch (err: any) {
      if (err.message === "Insufficient funds") {
        res.status(400).json({ error: true, message: "Insufficient funds" });
        return;
      }
      if (err.message === "One or both wallets not found") {
        res.status(404).json({ error: true, message: "One or both wallets not found" });
        return;
      }
      if (err.name === "RateLimitExceededError") {
        res.status(429).json({ error: true, message: err.message, retryAfter: 60 });
        return;
      }
      next(err);
    }
  }
);

export default router;
