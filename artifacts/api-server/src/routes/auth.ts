import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createSession } from "../lib/productAuth";
import { hashPin, verifyPin, isLegacyPinHash } from "../lib/pin";
import { loginRateLimit } from "../lib/loginRateLimit";

const router = Router();

// Backward-compatible auth endpoint expected by external clients.
router.post("/login", loginRateLimit, async (req, res) => {
  const { phone, pin } = req.body ?? {};
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
  } catch {
    return res.status(500).json({ error: true, message: "Login failed" });
  }
});

export default router;
