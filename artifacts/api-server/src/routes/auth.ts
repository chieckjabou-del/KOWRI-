import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { createSession } from "../lib/productAuth";
import {
  createOtpChallenge,
  enableBiometricUnlock,
  getKycStatusWithLimits,
  parseDeviceContext,
  trackAuthEvent,
  verifyBiometricUnlock,
  verifyOtpChallenge,
  verifyPinWithTrust,
} from "../lib/authFintech";

const router = Router();

function extractRequestDevice(req: any) {
  return parseDeviceContext({
    deviceId: req.headers["x-device-id"] as string | undefined,
    ipAddress: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.ip,
    userAgent: req.headers["user-agent"] as string | undefined,
    deviceLabel: req.body?.deviceLabel as string | undefined,
  });
}

function sendAuthFastHints(res: any): void {
  res.setHeader("X-Auth-Weak-Network-Mode", "1");
  res.setHeader("X-Auth-Primary-Method", "phone_otp");
}

async function buildAuthResponse(user: {
  id: string;
  phone: string;
  firstName: string;
  lastName: string;
  status: string;
  country: string;
}, device: { deviceId: string; ipAddress: string }, authMeta?: {
  suspicious: boolean;
  riskScore: number;
  deviceTrustScore: number;
  kyc: {
    level: number;
    monthlyLimitXof: number;
    monthlyUsedXof: number;
    monthlyRemainingXof: number;
    nextLevelHint: string;
  };
}) {
  const session = await createSession(user.id, "wallet", {
    deviceId: device.deviceId,
    ipAddress: device.ipAddress,
    ttlHours: 24,
  });
  const kyc = authMeta?.kyc ?? (await getKycStatusWithLimits(user.id));
  return {
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
    authMeta: {
      primaryMethod: "phone_otp",
      suspicious: authMeta?.suspicious ?? false,
      riskScore: authMeta?.riskScore ?? 0,
      deviceTrustScore: authMeta?.deviceTrustScore ?? 55,
      weakNetworkMode: true,
      kyc,
    },
  };
}

router.post("/otp/request", async (req, res) => {
  const { phone, purpose } = req.body ?? {};
  if (!phone) {
    return res.status(400).json({ error: true, message: "phone required" });
  }
  const device = extractRequestDevice(req);
  try {
    sendAuthFastHints(res);
    const challenge = await createOtpChallenge({
      phone,
      purpose: purpose === "register" || purpose === "pin_reset" ? purpose : "login",
      device,
    });
    const includeDebugOtp =
      process.env.NODE_ENV !== "production" && process.env.AUTH_EXPOSE_DEBUG_OTP === "1";
    return res.status(201).json({
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      delivery: "sms",
      ...(includeDebugOtp ? { debugOtp: challenge.debugOtp } : {}),
      fastProviders: {
        googleEnabled: process.env.AUTH_GOOGLE_ENABLED === "1",
        appleEnabled: process.env.AUTH_APPLE_ENABLED === "1",
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: true, message: err?.message ?? "OTP request failed" });
  }
});

router.post("/otp/verify", async (req, res) => {
  const { challengeId, phone, otp } = req.body ?? {};
  if (!challengeId || !phone || !otp) {
    return res.status(400).json({ error: true, message: "challengeId, phone, otp required" });
  }
  const device = extractRequestDevice(req);
  try {
    sendAuthFastHints(res);
    const result = await verifyOtpChallenge({ challengeId, phone, otp, device });
    if (!result.ok || !result.user || !result.meta) {
      await trackAuthEvent({
        phone,
        method: "otp",
        status: "failed",
        reason: result.reason ?? "otp_failed",
        suspicious: false,
        riskScore: 0,
        device,
      });
      return res.status(401).json({ error: true, message: result.reason ?? "OTP verification failed" });
    }
    await trackAuthEvent({
      userId: result.user.id,
      phone: result.user.phone,
      method: "otp",
      status: "success",
      reason: result.meta.suspicious ? "suspicious_login" : "ok",
      suspicious: result.meta.suspicious,
      riskScore: result.meta.riskScore,
      device,
    });
    return res.json(await buildAuthResponse(result.user, device, result.meta));
  } catch (err: any) {
    return res.status(500).json({ error: true, message: err?.message ?? "OTP verification failed" });
  }
});

router.post("/pin/login", async (req, res) => {
  const { phone, pin } = req.body ?? {};
  if (!phone || !pin) {
    return res.status(400).json({ error: true, message: "phone and pin required" });
  }
  const device = extractRequestDevice(req);
  try {
    sendAuthFastHints(res);
    const result = await verifyPinWithTrust({ phone, pin, device });
    if (!result.ok || !result.user || !result.meta) {
      await trackAuthEvent({
        phone,
        method: "pin",
        status: "failed",
        reason: result.reason ?? "pin_failed",
        suspicious: false,
        riskScore: 0,
        device,
      });
      return res.status(401).json({ error: true, message: result.reason ?? "Invalid credentials" });
    }
    await trackAuthEvent({
      userId: result.user.id,
      phone: result.user.phone,
      method: "pin",
      status: "success",
      reason: result.meta.suspicious ? "suspicious_login" : "ok",
      suspicious: result.meta.suspicious,
      riskScore: result.meta.riskScore,
      device,
    });
    return res.json(await buildAuthResponse(result.user, device, result.meta));
  } catch (err: any) {
    return res.status(500).json({ error: true, message: err?.message ?? "PIN login failed" });
  }
});

router.post("/social/login", async (req, res) => {
  const { provider, phone } = req.body ?? {};
  if (!provider || !["google", "apple"].includes(provider)) {
    return res.status(400).json({ error: true, message: "provider must be google or apple" });
  }
  const device = extractRequestDevice(req);
  const providerEnabled =
    provider === "google"
      ? process.env.AUTH_GOOGLE_ENABLED === "1"
      : process.env.AUTH_APPLE_ENABLED === "1";
  if (!providerEnabled) {
    return res.status(403).json({ error: true, message: `${provider} login disabled` });
  }
  if (!phone) {
    return res.status(400).json({ error: true, message: "phone required for social linking" });
  }
  try {
    sendAuthFastHints(res);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    if (!user) return res.status(404).json({ error: true, message: "User not found for provided phone" });
    const authMeta = {
      suspicious: false,
      riskScore: 8,
      deviceTrustScore: 70,
      kyc: await getKycStatusWithLimits(user.id),
    };
    await trackAuthEvent({
      userId: user.id,
      phone: user.phone,
      method: provider,
      status: "success",
      reason: "social_fast_login",
      suspicious: false,
      riskScore: 8,
      device,
    });
    return res.json(await buildAuthResponse({
      id: user.id,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      country: user.country,
    }, device, authMeta));
  } catch (err: any) {
    return res.status(500).json({ error: true, message: err?.message ?? "Social login failed" });
  }
});

router.post("/biometric/enable", async (req, res) => {
  const { userId, unlockToken } = req.body ?? {};
  if (!userId || !unlockToken) {
    return res.status(400).json({ error: true, message: "userId and unlockToken required" });
  }
  const device = extractRequestDevice(req);
  try {
    await enableBiometricUnlock({ userId, device, unlockToken });
    return res.status(201).json({ enabled: true, message: "Biometric unlock enabled on this device." });
  } catch (err: any) {
    return res.status(500).json({ error: true, message: err?.message ?? "Biometric enable failed" });
  }
});

router.post("/biometric/login", async (req, res) => {
  const { userId, unlockToken } = req.body ?? {};
  if (!userId || !unlockToken) {
    return res.status(400).json({ error: true, message: "userId and unlockToken required" });
  }
  const device = extractRequestDevice(req);
  try {
    sendAuthFastHints(res);
    const verify = await verifyBiometricUnlock({ userId, device, unlockToken });
    if (!verify.ok) {
      await trackAuthEvent({
        userId,
        method: "biometric",
        status: "failed",
        reason: verify.reason ?? "biometric_failed",
        suspicious: false,
        riskScore: 0,
        device,
      });
      return res.status(401).json({ error: true, message: verify.reason ?? "Biometric login failed" });
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) return res.status(404).json({ error: true, message: "User not found" });
    await trackAuthEvent({
      userId: user.id,
      phone: user.phone,
      method: "biometric",
      status: "success",
      reason: "device_unlock",
      suspicious: false,
      riskScore: 5,
      device,
    });
    return res.json(await buildAuthResponse({
      id: user.id,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      country: user.country,
    }, device, {
      suspicious: false,
      riskScore: 5,
      deviceTrustScore: 80,
      kyc: await getKycStatusWithLimits(user.id),
    }));
  } catch (err: any) {
    return res.status(500).json({ error: true, message: err?.message ?? "Biometric login failed" });
  }
});

router.get("/risk/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const events = await db.execute(sql`
      SELECT
        method,
        status,
        suspicious,
        risk_score AS "riskScore",
        created_at AS "createdAt",
        reason
      FROM auth_login_events
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 20
    `);
    return res.json({ events: (events.rows ?? []) as unknown[] });
  } catch (err: any) {
    return res.status(500).json({ error: true, message: err?.message ?? "Risk events unavailable" });
  }
});

// Backward-compatible auth endpoint expected by external clients.
router.post("/login", async (req, res) => {
  const { phone, pin } = req.body ?? {};
  if (!phone || !pin) {
    return res.status(400).json({ error: true, message: "phone and pin required" });
  }
  const device = extractRequestDevice(req);
  try {
    sendAuthFastHints(res);
    const result = await verifyPinWithTrust({ phone, pin, device });
    if (!result.ok || !result.user || !result.meta) {
      await trackAuthEvent({
        phone,
        method: "pin",
        status: "failed",
        reason: result.reason ?? "pin_failed",
        suspicious: false,
        riskScore: 0,
        device,
      });
      return res.status(401).json({ error: true, message: result.reason ?? "Invalid credentials" });
    }
    await trackAuthEvent({
      userId: result.user.id,
      phone: result.user.phone,
      method: "pin",
      status: "success",
      reason: result.meta.suspicious ? "suspicious_login" : "ok",
      suspicious: result.meta.suspicious,
      riskScore: result.meta.riskScore,
      device,
    });
    return res.json(await buildAuthResponse(result.user, device, result.meta));
  } catch (err: any) {
    return res.status(500).json({ error: true, message: err?.message ?? "Login failed" });
  }
});

export default router;
