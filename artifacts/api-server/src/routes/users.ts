import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, walletsTable, tontineMembersTable, transactionsTable, kycRecordsTable } from "@workspace/db";
import { eq, count, sql, desc } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { generateId } from "../lib/id";
import { validateQueryParams, VALID_USER_STATUSES } from "../middleware/validate";
import { createSession } from "../lib/productAuth";
import { hashPin, verifyPin, isLegacyPinHash, isValidPinFormat } from "../lib/pin";
import { loginRateLimit } from "../lib/loginRateLimit";
import { authenticate, requireAdmin, requireSelfOrAdmin } from "../middleware/auth";
import { routeParamString } from "../lib/routeParams";

const router = Router();
type UserRow = InferSelectModel<typeof usersTable>;
type KycRow = InferSelectModel<typeof kycRecordsTable>;

router.get("/me", authenticate(), async (req, res) => {
  try {
    const users = await db.select({
      id: usersTable.id, phone: usersTable.phone,
      firstName: usersTable.firstName, lastName: usersTable.lastName,
      status: usersTable.status, country: usersTable.country,
      email: usersTable.email,
    }).from(usersTable).where(eq(usersTable.id, req.auth!.userId)).limit(1);
    if (!users[0]) return res.status(404).json({ error: "Utilisateur introuvable" });
    return res.json({ user: users[0], sessionType: req.auth!.type });
  } catch (err) {
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/", requireAdmin, validateQueryParams({ status: VALID_USER_STATUSES }), async (req, res, next) => {
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

    return res.json({
      users: users.map((u: UserRow) => ({
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
    return next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { phone, email, firstName, lastName, country, pin } = req.body ?? {};

    if (!phone || !firstName || !pin) {
      return res.status(400).json({ error: "Bad request", message: "Téléphone, prénom et PIN sont requis" });
    }
    if (!isValidPinFormat(String(pin))) {
      return res.status(400).json({ error: "Bad request", message: "Le PIN doit contenir 4 à 6 chiffres" });
    }

    const id = generateId();

    // DB schema: last_name and country are NOT NULL — use empty string when not provided
    const [user] = await db.insert(usersTable).values({
      id,
      phone:     String(phone).replace(/\s/g, ""),
      email:     email    ? String(email)   : null,
      firstName: String(firstName).trim(),
      lastName:  lastName ? String(lastName).trim() : "",
      country:   country  ? String(country) : "",
      pinHash:   hashPin(String(pin)),
      status:   "pending_kyc",
      kycLevel: 0,
    }).returning();

    await db.insert(walletsTable).values({
      id:     generateId(),
      userId: user.id,
    }).onConflictDoNothing();

    return res.status(201).json({
      id:        user.id,
      phone:     user.phone,
      email:     user.email,
      firstName: user.firstName,
      lastName:  user.lastName,
      status:    user.status,
      kycLevel:  user.kycLevel,
      country:   user.country,
      createdAt: user.createdAt,
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      return res.status(409).json({ error: true, message: "Ce numéro est déjà enregistré" });
    }
    return next(err);
  }
});

router.post("/login", loginRateLimit, async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) {
    return res.status(400).json({ error: true, message: "phone and pin required" });
  }
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    if (!user || !verifyPin(String(pin), user.pinHash)) {
      return res.status(401).json({ error: true, message: "Invalid credentials" });
    }
    if (isLegacyPinHash(user.pinHash)) {
      await db.update(usersTable).set({ pinHash: hashPin(String(pin)), updatedAt: new Date() }).where(eq(usersTable.id, user.id));
    }
    const session = await createSession(user.id, "wallet", { ipAddress: req.ip });
    return res.json({
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
    return res.status(500).json({ error: true, message: "Login failed" });
  }
});

router.get("/:userId", authenticate(), requireSelfOrAdmin(), async (req, res, next) => {
  try {
    const userId = routeParamString(req, "userId")!;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));

    if (!user) {
      return res.status(404).json({ error: true, message: "User not found" });
    }

    const [[walletData], [txData], [tontineData]] = await Promise.all([
      db.select({ count: count(), total: sql`COALESCE(SUM(CAST(${walletsTable.balance} AS NUMERIC)), 0)` })
        .from(walletsTable).where(eq(walletsTable.userId, userId)),
      db.select({ count: count() })
        .from(transactionsTable)
        .where(sql`${transactionsTable.fromWalletId} IN (SELECT id FROM wallets WHERE user_id = ${userId}) OR ${transactionsTable.toWalletId} IN (SELECT id FROM wallets WHERE user_id = ${userId})`),
      db.select({ count: count() }).from(tontineMembersTable).where(eq(tontineMembersTable.userId, userId)),
    ]);

    return res.json({
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
    return next(err);
  }
});

// ── KYC: GET latest record for a user ─────────────────────────────────────────
router.get("/:userId/kyc", authenticate(), requireSelfOrAdmin(), async (req, res, next) => {
  try {
    const records = await db
      .select()
      .from(kycRecordsTable)
      .where(eq(kycRecordsTable.userId, routeParamString(req, "userId")!))
      .orderBy(desc(kycRecordsTable.submittedAt))
      .limit(10);

    const latest = records[0] ?? null;
    return res.json({
      record: latest ? {
        id: latest.id,
        kycLevel: latest.kycLevel,
        status: latest.status,
        documentType: latest.documentType,
        documentNumber: latest.documentNumber,
        fullName: latest.fullName,
        dateOfBirth: latest.dateOfBirth,
        rejectionReason: latest.rejectionReason,
        submittedAt: latest.submittedAt,
        verifiedAt: latest.verifiedAt,
      } : null,
      history: records.map((r: KycRow) => ({
        id: r.id, kycLevel: r.kycLevel, status: r.status, submittedAt: r.submittedAt,
      })),
    });
  } catch (err) { return next(err); }
});

// ── KYC: POST submit new KYC application ──────────────────────────────────────
router.post("/:userId/kyc", authenticate(), requireSelfOrAdmin(), async (req, res, next) => {
  try {
    const {
      kycLevel, documentType, documentNumber,
      fullName, dateOfBirth,
      documentFront, selfie, proofOfAddress, secondDocument,
    } = req.body;

    if (!kycLevel || !documentType || !fullName || !dateOfBirth || !documentNumber) {
      return res.status(400).json({ error: true, message: "Missing required fields" });
    }

    const [record] = await db.insert(kycRecordsTable).values({
      id:             generateId(),
      userId:         routeParamString(req, "userId")!,
      kycLevel:       Number(kycLevel),
      documentType:   documentType as any,
      documentNumber: documentNumber ?? null,
      fullName:       fullName ?? null,
      dateOfBirth:    dateOfBirth ?? null,
      documentFront:  documentFront ?? null,
      selfie:         selfie ?? null,
      proofOfAddress: proofOfAddress ?? null,
      secondDocument: secondDocument ?? null,
      status:         "pending",
    }).returning();

    return res.status(201).json({ success: true, record: { id: record.id, status: record.status, kycLevel: record.kycLevel } });
  } catch (err) { return next(err); }
});

// ── Avatar: PATCH update user avatar ──────────────────────────────────────────
router.patch("/:userId/avatar", authenticate(), requireSelfOrAdmin(), async (req, res, next) => {
  try {
    const { avatarBase64 } = req.body;
    if (!avatarBase64) { res.status(400).json({ error: true, message: "avatarBase64 required" }); return; }

    await db
      .update(usersTable)
      .set({ avatarUrl: avatarBase64, updatedAt: new Date() })
      .where(eq(usersTable.id, routeParamString(req, "userId")!));

    return res.json({ success: true });
  } catch (err) { return next(err); }
});

// ── PIN: PATCH update user PIN ───────────────────────────────────────────────
router.patch("/:userId/pin", authenticate(), async (req, res, next) => {
  try {
    if (req.auth!.userId !== routeParamString(req, "userId")!) {
      return res.status(403).json({ error: true, message: "Forbidden" });
    }

    const { oldPin, newPin } = req.body ?? {};
    const oldPinStr = String(oldPin ?? "");
    const newPinStr = String(newPin ?? "");

    if (!isValidPinFormat(oldPinStr) || !isValidPinFormat(newPinStr)) {
      return res.status(400).json({ error: true, message: "Ancien et nouveau PIN (4 à 6 chiffres) requis" });
    }
    if (oldPinStr === newPinStr) {
      return res.status(400).json({ error: true, message: "Le nouveau PIN doit être différent" });
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, routeParamString(req, "userId")!)).limit(1);
    if (!user) {
      return res.status(404).json({ error: true, message: "Utilisateur introuvable" });
    }

    if (!verifyPin(oldPinStr, user.pinHash)) {
      return res.status(401).json({ error: true, message: "Ancien PIN incorrect" });
    }

    await db
      .update(usersTable)
      .set({ pinHash: hashPin(newPinStr), updatedAt: new Date() })
      .where(eq(usersTable.id, routeParamString(req, "userId")!));

    return res.json({ success: true, message: "PIN mis à jour" });
  } catch (err) {
    return next(err);
  }
});

export default router;
