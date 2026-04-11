import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, walletsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createSession } from "../lib/productAuth";
import { hashPin, isValidPin, normalizePhone, verifyPin } from "../lib/password";
import { generateId } from "../lib/id";

const router = Router();

router.post("/register", async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const pin = String(req.body?.pin ?? "");
  const firstName = String(req.body?.firstName ?? "").trim();
  const lastName = String(req.body?.lastName ?? "").trim();
  const country = String(req.body?.country ?? "").trim();
  const email = req.body?.email ? String(req.body.email).trim() : null;

  if (!phone || !pin || !firstName) {
    return res.status(400).json({ error: true, message: "phone, pin and firstName are required" });
  }
  if (!isValidPin(pin)) {
    return res.status(400).json({ error: true, message: "pin must be exactly 4 digits" });
  }

  try {
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    if (existing[0]) {
      return res.status(409).json({ error: true, message: "Phone already registered" });
    }

    const userId = generateId("usr");
    const pinHash = await hashPin(pin);
    const [user] = await db.insert(usersTable).values({
      id: userId,
      phone,
      email,
      firstName,
      lastName,
      country,
      pinHash,
      status: "pending_kyc",
      kycLevel: 0,
    }).returning();

    await db.insert(walletsTable).values({
      id: generateId("wal"),
      userId: user.id,
      currency: "XOF",
      walletType: "personal",
      balance: "0",
      availableBalance: "0",
      status: "active",
    }).onConflictDoNothing();

    const session = await createSession(user.id, "wallet");
    return res.status(201).json({
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
  } catch {
    return res.status(500).json({ error: true, message: "Registration failed" });
  }
});

// Backward-compatible auth endpoint expected by external clients.
router.post("/login", async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const pin = String(req.body?.pin ?? "");
  if (!phone || !pin) {
    return res.status(400).json({ error: true, message: "phone and pin required" });
  }
  if (!isValidPin(pin)) {
    return res.status(400).json({ error: true, message: "pin must be exactly 4 digits" });
  }

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    if (!user) {
      return res.status(401).json({ error: true, message: "Invalid credentials" });
    }

    const ok = await verifyPin(pin, (user as any).pinHash);
    if (!ok) {
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
  } catch {
    return res.status(500).json({ error: true, message: "Login failed" });
  }
});

export default router;
