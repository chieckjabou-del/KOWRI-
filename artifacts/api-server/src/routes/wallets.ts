import { Router } from "express";
import { db } from "@workspace/db";
import { walletsTable, transactionsTable, ledgerEntriesTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";
import { generateId, generateReference } from "../lib/id";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const userId = req.query.userId as string | undefined;
    const currency = req.query.currency as string | undefined;

    const conditions: any[] = [];
    if (userId) conditions.push(eq(walletsTable.userId, userId));
    if (currency) conditions.push(eq(walletsTable.currency, currency));

    const whereClause = conditions.length > 0 ? sql`${conditions.reduce((a, b) => sql`${a} AND ${b}`)}` : undefined;

    const [wallets, [{ total }]] = await Promise.all([
      db.select().from(walletsTable).where(whereClause).limit(limit).offset(offset).orderBy(sql`${walletsTable.createdAt} DESC`),
      db.select({ total: count() }).from(walletsTable).where(whereClause),
    ]);

    res.json({
      wallets: wallets.map(w => ({
        ...w,
        balance: Number(w.balance),
        availableBalance: Number(w.availableBalance),
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.post("/", async (req, res) => {
  try {
    const { userId, currency, walletType } = req.body;
    if (!userId || !currency || !walletType) {
      return res.status(400).json({ error: "Bad request", message: "Missing required fields" });
    }

    const [wallet] = await db.insert(walletsTable).values({
      id: generateId(),
      userId,
      currency,
      walletType,
      balance: "0",
      availableBalance: "0",
      status: "active",
    }).returning();

    res.status(201).json({ ...wallet, balance: Number(wallet.balance), availableBalance: Number(wallet.availableBalance) });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.get("/:walletId", async (req, res) => {
  try {
    const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, req.params.walletId));
    if (!wallet) return res.status(404).json({ error: "Not found", message: "Wallet not found" });
    res.json({ ...wallet, balance: Number(wallet.balance), availableBalance: Number(wallet.availableBalance) });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.post("/:walletId/deposit", async (req, res) => {
  try {
    const { walletId } = req.params;
    const { amount, currency, reference, description } = req.body;

    if (!amount || amount <= 0 || !currency || !reference) {
      return res.status(400).json({ error: "Bad request", message: "Invalid deposit parameters" });
    }

    const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, walletId));
    if (!wallet) return res.status(404).json({ error: "Not found", message: "Wallet not found" });

    const txId = generateId();
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.update(walletsTable)
        .set({
          balance: sql`CAST(${walletsTable.balance} AS NUMERIC) + ${Number(amount)}`,
          availableBalance: sql`CAST(${walletsTable.availableBalance} AS NUMERIC) + ${Number(amount)}`,
          updatedAt: now,
        })
        .where(eq(walletsTable.id, walletId));

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
    });

    const [tx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, txId));
    res.json({ ...tx, amount: Number(tx.amount) });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.post("/:walletId/transfer", async (req, res) => {
  try {
    const { walletId } = req.params;
    const { toWalletId, amount, currency, description, reference } = req.body;

    if (!toWalletId || !amount || amount <= 0 || !currency) {
      return res.status(400).json({ error: "Bad request", message: "Invalid transfer parameters" });
    }

    const [fromWallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, walletId));
    const [toWallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, toWalletId));

    if (!fromWallet) return res.status(404).json({ error: "Not found", message: "Source wallet not found" });
    if (!toWallet) return res.status(404).json({ error: "Not found", message: "Destination wallet not found" });

    if (Number(fromWallet.availableBalance) < Number(amount)) {
      return res.status(400).json({ error: "Insufficient funds", message: "Insufficient available balance" });
    }

    const txId = generateId();
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.update(walletsTable)
        .set({
          balance: sql`CAST(${walletsTable.balance} AS NUMERIC) - ${Number(amount)}`,
          availableBalance: sql`CAST(${walletsTable.availableBalance} AS NUMERIC) - ${Number(amount)}`,
          updatedAt: now,
        })
        .where(eq(walletsTable.id, walletId));

      await tx.update(walletsTable)
        .set({
          balance: sql`CAST(${walletsTable.balance} AS NUMERIC) + ${Number(amount)}`,
          availableBalance: sql`CAST(${walletsTable.availableBalance} AS NUMERIC) + ${Number(amount)}`,
          updatedAt: now,
        })
        .where(eq(walletsTable.id, toWalletId));

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
    });

    const [txResult] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, txId));
    res.json({ ...txResult, amount: Number(txResult.amount) });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

export default router;
