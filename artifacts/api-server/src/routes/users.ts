import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, walletsTable, tontineMembersTable, transactionsTable } from "@workspace/db";
import { eq, count, sql, ilike, or } from "drizzle-orm";
import { generateId } from "../lib/id";
import { createHash } from "crypto";
import { validateQueryParams, VALID_USER_STATUSES } from "../middleware/validate";
import { createSession } from "../lib/productAuth";

const router = Router();

router.get("/", validateQueryParams({ status: VALID_USER_STATUSES }), async (req, res, next) => {
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
    next(err);
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
      res.status(409).json({ error: true, message: "Phone number already registered" });
      return;
    }
    next(err);
  }
});

router.post("/login", async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) {
    return res.status(400).json({ error: true, message: "phone and pin required" });
  }
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    if (!user) return res.status(401).json({ error: true, message: "Invalid credentials" });
    const pinHash = createHash("sha256").update(String(pin)).digest("hex");
    if ((user as any).pinHash !== pinHash) {
      return res.status(401).json({ error: true, message: "Invalid credentials" });
    }
    const session = await createSession(user.id, "wallet");
    res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: {
        id: user.id,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        status: user.status,
        country: user.country,
      },
    });
  } catch (err) {
    res.status(500).json({ error: true, message: "Login failed" });
  }
});

router.get("/:userId", async (req, res, next) => {
  try {
    const { userId } = req.params;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));

    if (!user) {
      res.status(404).json({ error: true, message: "User not found" });
      return;
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
    next(err);
  }
});

export default router;
