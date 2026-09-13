import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createSession } from "../lib/productAuth";
import { hashPin, verifyPin, isLegacyPinHash } from "../lib/pin";
import { loginRateLimit } from "../lib/loginRateLimit";
import { requestVerification, verifyCode, verificationMode, PhoneVerificationError } from "../lib/phoneVerification";

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

// ── Phone verification before registration ───────────────────────────────────

router.get("/otp/policy", (_req, res) => {
  return res.json({ phoneVerification: verificationMode() });
});

router.post("/otp/request", async (req, res, next) => {
  try {
    const { phone, purpose } = req.body ?? {};
    if (!phone) return res.status(400).json({ error: true, message: "phone required" });
    const result = await requestVerification(String(phone), purpose === "registration" ? purpose : "registration", req.ip);
    return res.json({ sent: true, expiresAt: result.expiresAt, ...(result.devCode ? { devCode: result.devCode } : {}) });
  } catch (err) {
    if (err instanceof PhoneVerificationError) return res.status(err.status).json({ error: true, code: err.code, message: err.message });
    return next(err);
  }
});

// Wrong codes count as failures for the login rate limiter (same IP + phone bucket).
router.post("/otp/verify", loginRateLimit, async (req, res, next) => {
  try {
    const { phone, code, purpose } = req.body ?? {};
    if (!phone || !code) return res.status(400).json({ error: true, message: "phone and code required" });
    const result = await verifyCode(String(phone), String(code), purpose === "registration" ? purpose : "registration");
    return res.json({ verified: true, verificationToken: result.verificationToken, expiresAt: result.expiresAt });
  } catch (err) {
    if (err instanceof PhoneVerificationError) {
      return res.status(err.code === "OTP_INVALID" ? 401 : err.status).json({ error: true, code: err.code, message: err.message });
    }
    return next(err);
  }
});

export default router;
