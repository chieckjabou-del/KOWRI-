import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, walletsTable, tontineMembersTable, transactionsTable } from "@workspace/db";
import { eq, count, sql, ilike, or } from "drizzle-orm";
import { generateId } from "../lib/id";
import { createHash } from "crypto";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const status = req.query.status as string | undefined;
    const offset = (page - 1) * limit;

    const conditions = status ? eq(usersTable.status, status as any) : undefined;

    const [users, [{ total }]] = await Promise.all([
      db.select().from(usersTable)
        .where(conditions)
        .limit(limit)
        .offset(offset)
        .orderBy(sql`${usersTable.createdAt} DESC`),
      db.select({ total: count() }).from(usersTable).where(conditions),
    ]);

    res.json({
      users: users.map(u => ({
        id: u.id,
        phone: u.phone,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        status: u.status,
        kycLevel: u.kycLevel,
        creditScore: u.creditScore,
        country: u.country,
        createdAt: u.createdAt,
      })),
      pagination: {
        page,
        limit,
        total: Number(total),
        totalPages: Math.ceil(Number(total) / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.post("/", async (req, res) => {
  try {
    const { phone, email, firstName, lastName, country, pin } = req.body;
    if (!phone || !firstName || !lastName || !country || !pin) {
      return res.status(400).json({ error: "Bad request", message: "Missing required fields" });
    }

    const id = generateId();
    const pinHash = createHash("sha256").update(pin).digest("hex");

    const [user] = await db.insert(usersTable).values({
      id,
      phone,
      email: email || null,
      firstName,
      lastName,
      country,
      pinHash,
      status: "pending_kyc",
      kycLevel: 0,
    }).returning();

    res.status(201).json({
      id: user.id,
      phone: user.phone,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      kycLevel: user.kycLevel,
      country: user.country,
      createdAt: user.createdAt,
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      return res.status(409).json({ error: "Conflict", message: "Phone number already registered" });
    }
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));

    if (!user) {
      return res.status(404).json({ error: "Not found", message: "User not found" });
    }

    const [[walletData], [txData], [tontineData]] = await Promise.all([
      db.select({ count: count(), total: sql`COALESCE(SUM(CAST(${walletsTable.balance} AS NUMERIC)), 0)` })
        .from(walletsTable).where(eq(walletsTable.userId, userId)),
      db.select({ count: count() })
        .from(transactionsTable)
        .where(sql`${transactionsTable.fromWalletId} IN (SELECT id FROM wallets WHERE user_id = ${userId}) OR ${transactionsTable.toWalletId} IN (SELECT id FROM wallets WHERE user_id = ${userId})`),
      db.select({ count: count() }).from(tontineMembersTable).where(eq(tontineMembersTable.userId, userId)),
    ]);

    res.json({
      id: user.id,
      phone: user.phone,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      kycLevel: user.kycLevel,
      creditScore: user.creditScore,
      country: user.country,
      createdAt: user.createdAt,
      walletCount: Number(walletData.count),
      totalBalance: Number(walletData.total),
      totalTransactions: Number(txData.count),
      tontineCount: Number(tontineData.count),
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

export default router;
