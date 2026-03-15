import { Router } from "express";
import { db } from "@workspace/db";
import { transactionsTable, ledgerEntriesTable } from "@workspace/db";
import { eq, sql, count, and } from "drizzle-orm";
import { validateQueryParams, VALID_TX_STATUSES } from "../middleware/validate";

const router = Router();

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
    if (walletId) {
      conditions.push(sql`(${transactionsTable.fromWalletId} = ${walletId} OR ${transactionsTable.toWalletId} = ${walletId})`);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [transactions, [{ total }]] = await Promise.all([
      db.select().from(transactionsTable).where(where).limit(limit).offset(offset).orderBy(sql`${transactionsTable.createdAt} DESC`),
      db.select({ total: count() }).from(transactionsTable).where(where),
    ]);

    res.json({
      transactions: transactions.map((t) => ({ ...t, amount: Number(t.amount) })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:transactionId", async (req, res, next) => {
  try {
    const [tx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, req.params.transactionId));
    if (!tx) {
      res.status(404).json({ error: true, message: "Transaction not found" });
      return;
    }
    res.json({ ...tx, amount: Number(tx.amount) });
  } catch (err) {
    next(err);
  }
});

export default router;
