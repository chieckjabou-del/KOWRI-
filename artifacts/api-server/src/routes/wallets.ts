import { Router } from "express";
import { db } from "@workspace/db";
import { walletsTable, transactionsTable, ledgerEntriesTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";
import { generateId, generateReference } from "../lib/id";
import { syncWalletBalance, getWalletBalance } from "../lib/walletService";
import { validatePagination, validateQueryParams, VALID_CURRENCIES } from "../middleware/validate";

const router = Router();

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
      .values({
        id: generateId(),
        userId,
        currency,
        walletType,
        balance: "0",
        availableBalance: "0",
        status: "active",
      })
      .returning();

    res.status(201).json({ ...wallet, balance: 0, availableBalance: 0 });
  } catch (err) {
    next(err);
  }
});

router.get("/:walletId", async (req, res, next) => {
  try {
    const [wallet] = await db
      .select()
      .from(walletsTable)
      .where(eq(walletsTable.id, req.params.walletId));

    if (!wallet) {
      res.status(404).json({ error: true, message: "Wallet not found" });
      return;
    }

    const derivedBalance = await getWalletBalance(req.params.walletId);

    res.json({
      ...wallet,
      balance: derivedBalance,
      availableBalance: derivedBalance,
      balanceSource: "ledger",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:walletId/deposit", async (req, res, next) => {
  try {
    const { walletId } = req.params;
    const { amount, currency, reference, description } = req.body;

    if (!amount || Number(amount) <= 0 || !currency || !reference) {
      res.status(400).json({ error: true, message: "Invalid deposit parameters: amount, currency, and reference are required" });
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

    const txId = generateId();
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(transactionsTable).values({
        id: txId,
        fromWalletId: null,
        toWalletId: walletId,
        amount: String(amount),
        currency,
        type: "deposit",
        status: "completed",
        reference: reference || generateReference(),
        description: description || "Deposit",
        completedAt: now,
      });

      await tx.insert(ledgerEntriesTable).values([
        {
          id: generateId(),
          transactionId: txId,
          accountId: "platform_float",
          accountType: "platform",
          debitAmount: String(amount),
          creditAmount: "0",
          currency,
          eventType: "deposit",
          description: "Platform float debit",
        },
        {
          id: generateId(),
          transactionId: txId,
          accountId: walletId,
          accountType: "wallet",
          debitAmount: "0",
          creditAmount: String(amount),
          currency,
          eventType: "deposit",
          description: "Wallet credit",
        },
      ]);

      const derived = await syncWalletBalance(walletId, tx as any);

      await tx
        .update(walletsTable)
        .set({ balance: String(derived), availableBalance: String(derived), updatedAt: now })
        .where(eq(walletsTable.id, walletId));
    });

    const [txResult] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, txId));
    res.json({ ...txResult, amount: Number(txResult.amount) });
  } catch (err) {
    next(err);
  }
});

router.post("/:walletId/transfer", async (req, res, next) => {
  try {
    const { walletId } = req.params;
    const { toWalletId, amount, currency, description, reference } = req.body;

    if (!toWalletId || !amount || Number(amount) <= 0 || !currency) {
      res.status(400).json({ error: true, message: "Invalid transfer parameters: toWalletId, amount, and currency are required" });
      return;
    }

    if (!VALID_CURRENCIES.has(currency)) {
      res.status(400).json({ error: true, message: `Invalid currency. Must be one of: ${[...VALID_CURRENCIES].join(", ")}` });
      return;
    }

    const [fromWallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, walletId));
    const [toWallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, toWalletId));

    if (!fromWallet) {
      res.status(404).json({ error: true, message: "Source wallet not found" });
      return;
    }
    if (!toWallet) {
      res.status(404).json({ error: true, message: "Destination wallet not found" });
      return;
    }

    const availableBal = await getWalletBalance(walletId);
    if (availableBal < Number(amount)) {
      res.status(400).json({ error: true, message: "Insufficient funds" });
      return;
    }

    const txId = generateId();
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(transactionsTable).values({
        id: txId,
        fromWalletId: walletId,
        toWalletId,
        amount: String(amount),
        currency,
        type: "transfer",
        status: "completed",
        reference: reference || generateReference(),
        description: description || "P2P Transfer",
        completedAt: now,
      });

      await tx.insert(ledgerEntriesTable).values([
        {
          id: generateId(),
          transactionId: txId,
          accountId: walletId,
          accountType: "wallet",
          debitAmount: String(amount),
          creditAmount: "0",
          currency,
          eventType: "transfer",
          description: "Transfer debit",
        },
        {
          id: generateId(),
          transactionId: txId,
          accountId: toWalletId,
          accountType: "wallet",
          debitAmount: "0",
          creditAmount: String(amount),
          currency,
          eventType: "transfer",
          description: "Transfer credit",
        },
      ]);

      const [fromDerived, toDerived] = await Promise.all([
        syncWalletBalance(walletId, tx as any),
        syncWalletBalance(toWalletId, tx as any),
      ]);

      await Promise.all([
        tx.update(walletsTable)
          .set({ balance: String(fromDerived), availableBalance: String(fromDerived), updatedAt: now })
          .where(eq(walletsTable.id, walletId)),
        tx.update(walletsTable)
          .set({ balance: String(toDerived), availableBalance: String(toDerived), updatedAt: now })
          .where(eq(walletsTable.id, toWalletId)),
      ]);
    });

    const [txResult] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, txId));
    res.json({ ...txResult, amount: Number(txResult.amount) });
  } catch (err) {
    next(err);
  }
});

export default router;
