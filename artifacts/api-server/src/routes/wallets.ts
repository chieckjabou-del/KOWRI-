import { Router } from "express";
import { db } from "@workspace/db";
import { walletsTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";
import { generateId, generateReference } from "../lib/id";
import { getWalletBalance } from "../lib/walletService";
import { processDeposit, processTransfer } from "../lib/walletService";
import { validatePagination, validateQueryParams, VALID_CURRENCIES } from "../middleware/validate";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";
import { routeParamString } from "../lib/routeParams";
import { audit } from "../lib/auditLogger";
import { authenticate, isAdminRequest, requireAdmin, walletBelongsToUser } from "../middleware/auth";

const router = Router();

router.use(authenticate());

router.get(
  "/",
  validatePagination,
  validateQueryParams({ currency: VALID_CURRENCIES }),
  async (req, res, next) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const offset = (page - 1) * limit;
      const requested = req.query.userId as string | undefined;
      // Non-admin callers only ever see their own wallets, whatever userId they pass.
      const userId = isAdminRequest(req) ? requested : req.auth!.userId;
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

      return res.json({
        wallets: wallets.map((w) => ({
          ...w,
          balance: Number(w.balance),
          availableBalance: Number(w.availableBalance),
        })),
        pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
      });
    } catch (err) {
      return next(err);
    }
  }
);

const VALID_WALLET_TYPES = new Set(["personal", "merchant", "savings", "tontine"]);

router.post("/", async (req, res, next) => {
  try {
    const { currency, walletType } = req.body;
    const userId = isAdminRequest(req) && typeof req.body.userId === "string" ? req.body.userId : req.auth!.userId;
    if (!currency || !walletType) {
      return res.status(400).json({ error: true, message: "Missing required fields: currency, walletType" });
    }
    if (!VALID_CURRENCIES.has(currency)) {
      return res.status(400).json({ error: true, message: `Invalid currency. Must be one of: ${[...VALID_CURRENCIES].join(", ")}` });
    }
    if (!VALID_WALLET_TYPES.has(walletType)) {
      return res.status(400).json({ error: true, message: `Invalid walletType. Must be one of: ${[...VALID_WALLET_TYPES].join(", ")}` });
    }

    const [wallet] = await db
      .insert(walletsTable)
      .values({ id: generateId(), userId, currency, walletType, balance: "0", availableBalance: "0", status: "active" })
      .returning();

    return res.status(201).json({ ...wallet, balance: 0, availableBalance: 0 });
  } catch (err) {
    return next(err);
  }
});

router.get("/:walletId", async (req, res, next) => {
  try {
    const walletId = routeParamString(req, "walletId")!;
    const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, walletId));
    if (!wallet || (!isAdminRequest(req) && wallet.userId !== req.auth!.userId)) {
      return res.status(404).json({ error: true, message: "Wallet not found" });
    }
    const derivedBalance = await getWalletBalance(walletId);
    return res.json({ ...wallet, balance: derivedBalance, availableBalance: derivedBalance, balanceSource: "ledger" });
  } catch (err) {
    return next(err);
  }
});

// Cash-in credits a wallet from platform float, so it is reserved to platform operators (agent/connector flows).
router.post(
  "/:walletId/deposit",
  requireAdmin,
  requireIdempotencyKey,
  checkIdempotency,
  async (req, res, next) => {
    try {
      const walletId = routeParamString(req, "walletId")!;
      const { amount, currency, reference, description } = req.body;

      if (!amount || Number(amount) <= 0 || !currency) {
        return res.status(400).json({ error: true, message: "Invalid deposit: amount (>0) and currency are required" });
      }
      if (!VALID_CURRENCIES.has(currency)) {
        return res.status(400).json({ error: true, message: `Invalid currency. Must be one of: ${[...VALID_CURRENCIES].join(", ")}` });
      }

      const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, walletId));
      if (!wallet) {
        return res.status(404).json({ error: true, message: "Wallet not found" });
      }

      const tx = await processDeposit({
        walletId,
        amount: Number(amount),
        currency,
        reference: reference ?? generateReference(),
        description,
        idempotencyKey: `deposit:${req.idempotencyKey}`,
      });

      return res.json({ ...tx, amount: Number(tx.amount) });
    } catch (err: any) {
      if (err.message === "Wallet not found") {
        return res.status(404).json({ error: true, message: "Wallet not found" });
      }
      return next(err);
    }
  }
);

router.post(
  "/:walletId/transfer",
  requireIdempotencyKey,
  checkIdempotency,
  async (req, res, next) => {
    try {
      const walletId = routeParamString(req, "walletId")!;
      const { toWalletId, amount, currency, description, reference } = req.body;

      if (!toWalletId || !amount || Number(amount) <= 0 || !currency) {
        return res.status(400).json({ error: true, message: "Invalid transfer: toWalletId, amount (>0), and currency are required" });
      }
      if (!VALID_CURRENCIES.has(currency)) {
        return res.status(400).json({ error: true, message: `Invalid currency. Must be one of: ${[...VALID_CURRENCIES].join(", ")}` });
      }
      if (walletId === toWalletId) {
        return res.status(400).json({ error: true, message: "Source and destination wallets must be different" });
      }
      if (!(await walletBelongsToUser(walletId, req.auth!.userId))) {
        return res.status(403).json({ error: true, message: "You do not own the source wallet" });
      }

      const tx = await processTransfer({
        fromWalletId: walletId,
        toWalletId,
        amount: Number(amount),
        currency,
        description,
        reference,
        idempotencyKey: `transfer:${req.auth!.userId}:${req.idempotencyKey}`,
      });

      return res.json({ ...tx, amount: Number(tx.amount) });
    } catch (err: any) {
      if (err.message === "Insufficient funds") {
        return res.status(400).json({ error: true, message: "Insufficient funds" });
      }
      if (err.name === "CurrencyMismatchError" || err.name === "WalletUnavailableError") {
        return res.status(400).json({ error: true, message: err.message });
      }
      if (err.name === "TransactionBlockedError") {
        return res.status(403).json({ error: true, code: "TRANSACTION_BLOCKED", message: "Cette opération a été bloquée par le contrôle de risque.", reasons: err.findings?.filter((f: any) => f.blocking).map((f: any) => f.type) });
      }
      if (err.message?.includes("not found")) {
        return res.status(404).json({ error: true, message: "One or both wallets not found" });
      }
      if (err.name === "RateLimitExceededError") {
        return res.status(429).json({ error: true, message: err.message, retryAfter: 60 });
      }
      return next(err);
    }
  }
);

export default router;
