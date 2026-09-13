import { Router } from "express";
import { db } from "@workspace/db";
import { transactionsTable, walletsTable } from "@workspace/db";
import { eq, sql, count, and, or, inArray } from "drizzle-orm";
import { validateQueryParams, VALID_TX_STATUSES } from "../middleware/validate";
import { authenticate, isAdminRequest } from "../middleware/auth";
import { routeParamString } from "../lib/routeParams";

const router = Router();

router.use(authenticate());

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
