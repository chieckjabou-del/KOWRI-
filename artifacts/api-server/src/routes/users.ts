import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, walletsTable, tontineMembersTable, transactionsTable, kycRecordsTable } from "@workspace/db";
import { eq, count, sql, desc } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { generateId } from "../lib/id";
import { createHash } from "crypto";
import { validateQueryParams, VALID_USER_STATUSES } from "../middleware/validate";
import { createSession, requireAuth } from "../lib/productAuth";

const router = Router();
type UserRow = InferSelectModel<typeof usersTable>;
type KycRow = InferSelectModel<typeof kycRecordsTable>;

router.get("/me", async (req, res) => {
  const auth = await requireAuth(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: "Session invalide ou expirée" });
  try {
    const users = await db.select({
      id: usersTable.id, phone: usersTable.phone,
      firstName: usersTable.firstName, lastName: usersTable.lastName,
      status: usersTable.status, country: usersTable.country,
      email: usersTable.email,
    }).from(usersTable).where(eq(usersTable.id, auth.userId)).limit(1);
    if (!users[0]) return res.status(404).json({ error: "Utilisateur introuvable" });
    return res.json({ user: users[0], sessionType: auth.type });
  } catch (err) {
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

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
    console.log("REGISTER INPUT:", { phone: req.body?.phone, firstName: req.body?.firstName, hasPin: !!req.body?.pin });

    const { phone, email, firstName, lastName, country, pin } = req.body ?? {};

    if (!phone || !firstName || !pin) {
      return res.status(400).json({ error: "Bad request", message: "Téléphone, prénom et PIN sont requis" });
    }

    const id       = generateId();
    const pinHash  = createHash("sha256").update(String(pin)).digest("hex");

    // DB schema: last_name and country are NOT NULL — use empty string when not provided
    const [user] = await db.insert(usersTable).values({
      id,
      phone:     String(phone).replace(/\s/g, ""),
      email:     email    ? String(email)   : null,
      firstName: String(firstName).trim(),
      lastName:  lastName ? String(lastName).trim() : "",
      country:   country  ? String(country) : "",
      pinHash,
      status:   "pending_kyc",
      kycLevel: 0,
    }).returning();

    // Auto-create wallet for new user (walletsTable already imported at top)
    await db.insert(walletsTable).values({
      id:     generateId(),
      userId: user.id,
    }).onConflictDoNothing();

    console.log("REGISTER OK:", user.id);

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
    console.error("REGISTER ERROR:", err?.message, err?.code, err?.detail);
    if (err?.code === "23505") {
      return res.status(409).json({ error: true, message: "Ce numéro est déjà enregistré" });
    }
    return next(err);
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

router.get("/:userId", async (req, res, next) => {
  try {
    const { userId } = req.params;
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
router.get("/:userId/kyc", async (req, res, next) => {
  try {
    const auth = await requireAuth(req.headers.authorization);
    if (!auth) { res.status(401).json({ error: true, message: "Unauthorized" }); return; }

    const records = await db
      .select()
      .from(kycRecordsTable)
      .where(eq(kycRecordsTable.userId, req.params.userId))
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
router.post("/:userId/kyc", async (req, res, next) => {
  try {
    const auth = await requireAuth(req.headers.authorization);
    if (!auth) { res.status(401).json({ error: true, message: "Unauthorized" }); return; }

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
      userId:         req.params.userId,
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
router.patch("/:userId/avatar", async (req, res, next) => {
  try {
    const auth = await requireAuth(req.headers.authorization);
    if (!auth) { res.status(401).json({ error: true, message: "Unauthorized" }); return; }

    const { avatarBase64 } = req.body;
    if (!avatarBase64) { res.status(400).json({ error: true, message: "avatarBase64 required" }); return; }

    await db
      .update(usersTable)
      .set({ avatarUrl: avatarBase64, updatedAt: new Date() })
      .where(eq(usersTable.id, req.params.userId));

    return res.json({ success: true });
  } catch (err) { return next(err); }
});

// ── PIN: PATCH update user PIN ───────────────────────────────────────────────
router.patch("/:userId/pin", async (req, res, next) => {
  try {
    const auth = await requireAuth(req.headers.authorization);
    if (!auth) {
      return res.status(401).json({ error: true, message: "Unauthorized" });
    }
    if (auth.userId !== req.params.userId) {
      return res.status(403).json({ error: true, message: "Forbidden" });
    }

    const { oldPin, newPin } = req.body ?? {};
    const oldPinStr = String(oldPin ?? "");
    const newPinStr = String(newPin ?? "");

    if (!/^\d{4}$/.test(oldPinStr) || !/^\d{4}$/.test(newPinStr)) {
      return res.status(400).json({ error: true, message: "Ancien et nouveau PIN (4 chiffres) requis" });
    }
    if (oldPinStr === newPinStr) {
      return res.status(400).json({ error: true, message: "Le nouveau PIN doit être différent" });
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.params.userId)).limit(1);
    if (!user) {
      return res.status(404).json({ error: true, message: "Utilisateur introuvable" });
    }

    const oldHash = createHash("sha256").update(oldPinStr).digest("hex");
    if ((user as any).pinHash !== oldHash) {
      return res.status(401).json({ error: true, message: "Ancien PIN incorrect" });
    }

    const newHash = createHash("sha256").update(newPinStr).digest("hex");
    await db
      .update(usersTable)
      .set({ pinHash: newHash, updatedAt: new Date() })
      .where(eq(usersTable.id, req.params.userId));

    return res.json({ success: true, message: "PIN mis à jour" });
  } catch (err) {
    return next(err);
  }
});

export default router;
