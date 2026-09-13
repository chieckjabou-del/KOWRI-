import { Router } from "express";
import { db } from "@workspace/db";
import { transactionsTable, walletsTable, usersTable } from "@workspace/db";
import { eq, sql, count, and, or, inArray } from "drizzle-orm";
import { validateQueryParams, VALID_TX_STATUSES, VALID_CURRENCIES } from "../middleware/validate";
import { authenticate, isAdminRequest, walletBelongsToUser } from "../middleware/auth";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";
import { processTransfer } from "../lib/walletService";
import { routeParamString } from "../lib/routeParams";

const router = Router();

router.use(authenticate());

// Send money to another customer by phone number — the mobile app's "Envoyer"
// screen. The recipient's wallet in the same currency is resolved here; the
// ledger movement is the same processTransfer as /wallets/:id/transfer, keyed
// on the caller's Idempotency-Key. The response carries the ledger status so
// the client never shows a non-completed transfer as a success.
router.post("/transfer", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { fromWalletId, recipientPhone, amount, currency = "XOF", description } = req.body ?? {};
    const numericAmount = Number(amount);
    if (typeof fromWalletId !== "string" || !fromWalletId || typeof recipientPhone !== "string" || !recipientPhone.trim()) {
      return res.status(400).json({ error: true, message: "fromWalletId and recipientPhone are required" });
    }
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: true, message: "amount must be a positive number" });
    }
    if (!VALID_CURRENCIES.has(currency)) {
      return res.status(400).json({ error: true, message: `Invalid currency. Must be one of: ${[...VALID_CURRENCIES].join(", ")}` });
    }
    if (!(await walletBelongsToUser(fromWalletId, req.auth!.userId))) {
      return res.status(403).json({ error: true, message: "You do not own the source wallet" });
    }
    const phone = recipientPhone.replace(/[\s.-]/g, "");
    const [recipient] = await db.select({ id: usersTable.id, status: usersTable.status }).from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    // The same answer whether the number is unknown or has no wallet in this
    // currency: a sender cannot enumerate customers by phone.
    const notFound = () => res.status(404).json({ error: true, code: "RECIPIENT_NOT_FOUND", message: "Aucun compte Akwê actif pour ce numéro dans cette devise" });
    if (!recipient || recipient.status === "suspended") return notFound();
    if (recipient.id === req.auth!.userId) return res.status(400).json({ error: true, message: "Vous ne pouvez pas vous envoyer de l'argent" });
    const [toWallet] = await db.select({ id: walletsTable.id }).from(walletsTable)
      .where(and(eq(walletsTable.userId, recipient.id), eq(walletsTable.currency, currency), eq(walletsTable.status, "active"))).limit(1);
    if (!toWallet) return notFound();

    const tx = await processTransfer({
      fromWalletId, toWalletId: toWallet.id, amount: numericAmount, currency,
      description: typeof description === "string" && description.trim() ? description.trim().slice(0, 200) : "Transfert P2P",
      idempotencyKey: `transfer:${req.auth!.userId}:${req.idempotencyKey}`,
    });
    const body = { success: tx.status === "completed", transaction: { ...tx, amount: Number(tx.amount) }, status: tx.status };
    await req.saveIdempotentResponse?.(body);
    return res.status(201).json(body);
  } catch (err: any) {
    if (err.message === "Insufficient funds") return res.status(400).json({ error: true, code: "INSUFFICIENT_FUNDS", message: "Solde insuffisant" });
    return next(err);
  }
});

// A product user only ever sees transactions touching one of their own wallets;
// the platform-wide view is for operators.
async function callerWalletIds(userId: string): Promise<string[]> {
  const rows = await db.select({ id: walletsTable.id }).from(walletsTable).where(eq(walletsTable.userId, userId));
  return rows.map((r) => r.id);
}

router.get("/", validateQueryParams({ status: VALID_TX_STATUSES }), async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const walletId = req.query.walletId as string | undefined;
    const type = req.query.type as string | undefined;
    const status = req.query.status as string | undefined;

    const conditions: any[] = [];
    if (type) conditions.push(eq(transactionsTable.type, type as any));
    if (status) conditions.push(eq(transactionsTable.status, status as any));

    if (!isAdminRequest(req)) {
      const owned = await callerWalletIds(req.auth!.userId);
      if (walletId && !owned.includes(walletId)) {
        return res.status(404).json({ error: true, message: "Wallet not found" });
      }
      const scope = walletId ? [walletId] : owned;
      if (scope.length === 0) {
        return res.json({ transactions: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      }
      conditions.push(or(inArray(transactionsTable.fromWalletId, scope), inArray(transactionsTable.toWalletId, scope)));
    } else if (walletId) {
      conditions.push(sql`(${transactionsTable.fromWalletId} = ${walletId} OR ${transactionsTable.toWalletId} = ${walletId})`);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [transactions, [{ total }]] = await Promise.all([
      db.select().from(transactionsTable).where(where).limit(limit).offset(offset).orderBy(sql`${transactionsTable.createdAt} DESC`),
      db.select({ total: count() }).from(transactionsTable).where(where),
    ]);

    return res.json({
      transactions: transactions.map((t) => ({ ...t, amount: Number(t.amount) })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:transactionId", async (req, res, next) => {
  try {
    const transactionId = routeParamString(req, "transactionId")!;
    const [tx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, transactionId));
    if (!tx) {
      return res.status(404).json({ error: true, message: "Transaction not found" });
    }
    if (!isAdminRequest(req)) {
      const owned = await callerWalletIds(req.auth!.userId);
      const mine = (tx.fromWalletId && owned.includes(tx.fromWalletId)) || (tx.toWalletId && owned.includes(tx.toWalletId));
      // 404, not 403: the existence of someone else's transaction is not disclosed.
      if (!mine) return res.status(404).json({ error: true, message: "Transaction not found" });
    }
    return res.json({ ...tx, amount: Number(tx.amount) });
  } catch (err) {
    return next(err);
  }
});

export default router;
