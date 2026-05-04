import { createHash, randomInt } from "crypto";
import { eq, and, gt, gte, desc, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  authDeviceTrustTable,
  authLoginEventsTable,
  authOtpChallengesTable,
  usersTable,
  walletsTable,
  transactionsTable,
  kycRecordsTable,
} from "@workspace/db";
import { generateId } from "./id";

const OTP_TTL_MINUTES = 5;
const DEVICE_BLOCK_MINUTES = 20;
let authSchemaReadyPromise: Promise<void> | null = null;

export type AuthMethod = "otp" | "pin" | "google" | "apple" | "biometric";
export type AuthStatus = "success" | "failed";

type DeviceContext = {
  deviceId: string;
  ipAddress: string;
  userAgent: string;
  deviceLabel?: string;
};

export type AuthUserPayload = {
  id: string;
  phone: string;
  firstName: string;
  lastName: string;
  status: string;
  country: string;
};

export type AuthSessionMeta = {
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
};

function ensureAuthSchemaReady(): Promise<void> {
  if (authSchemaReadyPromise) return authSchemaReadyPromise;
  authSchemaReadyPromise = (async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS auth_otp_challenges (
        id text PRIMARY KEY,
        phone text NOT NULL,
        purpose text NOT NULL DEFAULT 'login',
        otp_hash text NOT NULL,
        max_attempts integer NOT NULL DEFAULT 5,
        attempts integer NOT NULL DEFAULT 0,
        delivery_channel text NOT NULL DEFAULT 'sms',
        device_id text,
        ip_address text,
        user_agent text,
        expires_at timestamp NOT NULL,
        consumed_at timestamp,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS otp_phone_idx ON auth_otp_challenges(phone)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS otp_expires_idx ON auth_otp_challenges(expires_at)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS auth_login_events (
        id text PRIMARY KEY,
        user_id text,
        phone text,
        method text NOT NULL,
        status text NOT NULL,
        reason text,
        suspicious boolean NOT NULL DEFAULT false,
        risk_score integer NOT NULL DEFAULT 0,
        device_id text,
        ip_address text,
        user_agent text,
        metadata jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS auth_events_user_idx ON auth_login_events(user_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS auth_events_phone_idx ON auth_login_events(phone)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS auth_events_created_idx ON auth_login_events(created_at)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS auth_device_trust (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        device_id text NOT NULL,
        trust_score integer NOT NULL DEFAULT 55,
        failed_attempts integer NOT NULL DEFAULT 0,
        blocked_until timestamp,
        last_ip_hash text,
        biometric_enabled boolean NOT NULL DEFAULT false,
        biometric_unlock_hash text,
        device_label text,
        risk_flags jsonb,
        first_seen_at timestamp NOT NULL DEFAULT now(),
        last_login_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS device_trust_user_idx ON auth_device_trust(user_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS device_trust_device_idx ON auth_device_trust(device_id)`);
  })();
  return authSchemaReadyPromise;
}

const KYC_LIMITS_XOF: Record<number, number> = {
  0: 100_000,
  1: 1_000_000,
  2: 10_000_000,
};

function hashValue(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  return trimmed.replace(/\D/g, "");
}

export function parseDeviceContext(input: {
  deviceId?: string;
  ipAddress?: string;
  userAgent?: string;
  deviceLabel?: string;
}): DeviceContext {
  return {
    deviceId: (input.deviceId?.trim() || "unknown-device").slice(0, 120),
    ipAddress: (input.ipAddress?.trim() || "0.0.0.0").slice(0, 120),
    userAgent: (input.userAgent?.trim() || "unknown").slice(0, 400),
    deviceLabel: input.deviceLabel?.trim().slice(0, 120),
  };
}

function computeSuspicionFromLoginHistory(args: {
  trustScore: number;
  sameIpAsLast: boolean;
  hasBlockedUntil: boolean;
  recentFailures: number;
  method: AuthMethod;
}): { suspicious: boolean; riskScore: number } {
  let score = 0;
  if (args.trustScore < 40) score += 35;
  if (!args.sameIpAsLast) score += 20;
  if (args.recentFailures >= 3) score += 35;
  if (args.hasBlockedUntil) score += 25;
  if (args.method === "pin") score += 10;
  return { suspicious: score >= 55, riskScore: Math.min(score, 100) };
}

export function computeKycLimit(kycLevel: number): number {
  return KYC_LIMITS_XOF[kycLevel] ?? KYC_LIMITS_XOF[0];
}

export async function getMonthlySpentByUser(userId: string): Promise<number> {
  const [wallet] = await db
    .select({ id: walletsTable.id })
    .from(walletsTable)
    .where(eq(walletsTable.userId, userId))
    .limit(1);
  if (!wallet?.id) return 0;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(CAST(${transactionsTable.amount} AS NUMERIC)), 0)`,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.fromWalletId, wallet.id),
        eq(transactionsTable.status, "completed"),
        gte(transactionsTable.createdAt, monthStart),
      ),
    );
  return Number(row?.total ?? 0);
}

export function nextKycHint(kycLevel: number): string {
  if (kycLevel <= 0) return "Passe KYC niveau 1 pour monter a 1 000 000 XOF/mois.";
  if (kycLevel === 1) return "Passe KYC niveau 2 pour monter a 10 000 000 XOF/mois.";
  return "KYC complet actif. Limite premium en place.";
}

export async function getKycStatusWithLimits(userId: string): Promise<AuthSessionMeta["kyc"]> {
  const [user] = await db
    .select({ kycLevel: usersTable.kycLevel })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const level = user?.kycLevel ?? 0;
  const monthlyLimitXof = computeKycLimit(level);
  const monthlyUsedXof = await getMonthlySpentByUser(userId);
  return {
    level,
    monthlyLimitXof,
    monthlyUsedXof,
    monthlyRemainingXof: Math.max(0, monthlyLimitXof - monthlyUsedXof),
    nextLevelHint: nextKycHint(level),
  };
}

async function getOrCreateDeviceTrust(userId: string, device: DeviceContext) {
  const [existing] = await db
    .select()
    .from(authDeviceTrustTable)
    .where(
      and(
        eq(authDeviceTrustTable.userId, userId),
        eq(authDeviceTrustTable.deviceId, device.deviceId),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const record = {
    id: generateId("dvt"),
    userId,
    deviceId: device.deviceId,
    trustScore: 55,
    failedAttempts: 0,
    blockedUntil: null,
    lastIpHash: hashValue(device.ipAddress),
    biometricEnabled: false,
    biometricUnlockHash: null,
    deviceLabel: device.deviceLabel ?? null,
    riskFlags: [],
    firstSeenAt: new Date(),
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(authDeviceTrustTable).values(record);
  return record;
}

async function countRecentFailedLoginsForPhone(phone: string): Promise<number> {
  const result = await db
    .select({ id: authLoginEventsTable.id })
    .from(authLoginEventsTable)
    .where(
      and(
        eq(authLoginEventsTable.phone, phone),
        eq(authLoginEventsTable.status, "failed"),
        gt(authLoginEventsTable.createdAt, new Date(Date.now() - 30 * 60 * 1000)),
      ),
    );
  return result.length;
}

export async function trackAuthEvent(input: {
  userId?: string | null;
  phone?: string | null;
  method: AuthMethod;
  status: AuthStatus;
  reason?: string;
  suspicious?: boolean;
  riskScore?: number;
  device?: DeviceContext;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await ensureAuthSchemaReady();
  await db.insert(authLoginEventsTable).values({
    id: generateId("aev"),
    userId: input.userId ?? null,
    phone: input.phone ?? null,
    method: input.method,
    status: input.status,
    reason: input.reason ?? null,
    suspicious: Boolean(input.suspicious),
    riskScore: input.riskScore ?? 0,
    deviceId: input.device?.deviceId ?? null,
    ipAddress: input.device?.ipAddress ?? null,
    userAgent: input.device?.userAgent ?? null,
    metadata: input.metadata ?? {},
    createdAt: new Date(),
  });
}

export async function createOtpChallenge(input: {
  phone: string;
  purpose?: "login" | "register" | "pin_reset";
  device: DeviceContext;
}): Promise<{ challengeId: string; expiresAt: string; debugOtp: string }> {
  await ensureAuthSchemaReady();
  const phone = normalizePhone(input.phone);
  const otp = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000);

  const challengeId = generateId("otp");
  await db.insert(authOtpChallengesTable).values({
    id: challengeId,
    phone,
    purpose: input.purpose ?? "login",
    otpHash: hashValue(otp),
    maxAttempts: 5,
    attempts: 0,
    deliveryChannel: "sms",
    deviceId: input.device.deviceId,
    ipAddress: input.device.ipAddress,
    userAgent: input.device.userAgent,
    expiresAt,
    consumedAt: null,
    createdAt: new Date(),
  });

  return {
    challengeId,
    expiresAt: expiresAt.toISOString(),
    // In production this should be removed and replaced by SMS provider dispatch.
    debugOtp: otp,
  };
}

export async function verifyOtpChallenge(input: {
  challengeId: string;
  phone: string;
  otp: string;
  device: DeviceContext;
}): Promise<{ ok: boolean; reason?: string; user?: AuthUserPayload; meta?: AuthSessionMeta }> {
  await ensureAuthSchemaReady();
  const normalizedPhone = normalizePhone(input.phone);
  const [challenge] = await db
    .select()
    .from(authOtpChallengesTable)
    .where(eq(authOtpChallengesTable.id, input.challengeId))
    .limit(1);
  if (!challenge) return { ok: false, reason: "Challenge OTP introuvable." };
  if (challenge.phone !== normalizedPhone) return { ok: false, reason: "Numero OTP invalide." };
  if (challenge.consumedAt) return { ok: false, reason: "Challenge OTP deja utilise." };
  if (new Date(challenge.expiresAt).getTime() < Date.now()) return { ok: false, reason: "OTP expire." };
  if ((challenge.attempts ?? 0) >= (challenge.maxAttempts ?? 5)) {
    return { ok: false, reason: "Trop de tentatives OTP." };
  }

  const valid = hashValue(String(input.otp)) === challenge.otpHash;
  if (!valid) {
    await db
      .update(authOtpChallengesTable)
      .set({ attempts: (challenge.attempts ?? 0) + 1 })
      .where(eq(authOtpChallengesTable.id, challenge.id));
    return { ok: false, reason: "OTP invalide." };
  }

  await db
    .update(authOtpChallengesTable)
    .set({ consumedAt: new Date(), attempts: (challenge.attempts ?? 0) + 1 })
    .where(eq(authOtpChallengesTable.id, challenge.id));

  const [user] = await db
    .select({
      id: usersTable.id,
      phone: usersTable.phone,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      status: usersTable.status,
      country: usersTable.country,
    })
    .from(usersTable)
    .where(eq(usersTable.phone, normalizedPhone))
    .limit(1);

  if (!user) return { ok: false, reason: "Utilisateur introuvable pour ce numero." };

  const trust = await getOrCreateDeviceTrust(user.id, input.device);
  const recentFailures = await countRecentFailedLoginsForPhone(normalizedPhone);
  const sameIpAsLast = trust.lastIpHash === hashValue(input.device.ipAddress);
  const blockedUntilTs = trust.blockedUntil ? new Date(trust.blockedUntil).getTime() : 0;
  const suspiciousInfo = computeSuspicionFromLoginHistory({
    trustScore: trust.trustScore,
    sameIpAsLast,
    hasBlockedUntil: blockedUntilTs > Date.now(),
    recentFailures,
    method: "otp",
  });

  const nextTrustScore = Math.min(100, Math.max(20, trust.trustScore + (sameIpAsLast ? 6 : 2)));
  await db
    .update(authDeviceTrustTable)
    .set({
      trustScore: nextTrustScore,
      failedAttempts: 0,
      blockedUntil: null,
      lastIpHash: hashValue(input.device.ipAddress),
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(authDeviceTrustTable.id, trust.id));

  const kyc = await getKycStatusWithLimits(user.id);
  return {
    ok: true,
    user,
    meta: {
      suspicious: suspiciousInfo.suspicious,
      riskScore: suspiciousInfo.riskScore,
      deviceTrustScore: nextTrustScore,
      kyc,
    },
  };
}

export async function verifyPinWithTrust(input: {
  phone: string;
  pin: string;
  device: DeviceContext;
}): Promise<{ ok: boolean; reason?: string; user?: AuthUserPayload; meta?: AuthSessionMeta }> {
  await ensureAuthSchemaReady();
  const phone = normalizePhone(input.phone);
  const [user] = await db
    .select({
      id: usersTable.id,
      phone: usersTable.phone,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      status: usersTable.status,
      country: usersTable.country,
      pinHash: usersTable.pinHash,
    })
    .from(usersTable)
    .where(eq(usersTable.phone, phone))
    .limit(1);
  if (!user) return { ok: false, reason: "Identifiants invalides." };

  const trust = await getOrCreateDeviceTrust(user.id, input.device);
  const blocked = trust.blockedUntil && new Date(trust.blockedUntil).getTime() > Date.now();
  if (blocked) return { ok: false, reason: "Appareil temporairement bloque apres echecs repetes." };

  const providedHash = hashValue(String(input.pin));
  const pinValid = providedHash === user.pinHash;
  const recentFailures = await countRecentFailedLoginsForPhone(phone);
  const sameIpAsLast = trust.lastIpHash === hashValue(input.device.ipAddress);
  const suspiciousInfo = computeSuspicionFromLoginHistory({
    trustScore: trust.trustScore,
    sameIpAsLast,
    hasBlockedUntil: Boolean(blocked),
    recentFailures,
    method: "pin",
  });

  if (!pinValid) {
    const failedAttempts = (trust.failedAttempts ?? 0) + 1;
    const shouldBlock = failedAttempts >= 5;
    await db
      .update(authDeviceTrustTable)
      .set({
        failedAttempts,
        blockedUntil: shouldBlock ? new Date(Date.now() + DEVICE_BLOCK_MINUTES * 60_000) : null,
        trustScore: Math.max(20, trust.trustScore - 8),
        updatedAt: new Date(),
      })
      .where(eq(authDeviceTrustTable.id, trust.id));
    return { ok: false, reason: "PIN invalide." };
  }

  const nextTrustScore = Math.min(100, Math.max(20, trust.trustScore + (sameIpAsLast ? 4 : 1)));
  await db
    .update(authDeviceTrustTable)
    .set({
      failedAttempts: 0,
      blockedUntil: null,
      trustScore: nextTrustScore,
      lastIpHash: hashValue(input.device.ipAddress),
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(authDeviceTrustTable.id, trust.id));

  const kyc = await getKycStatusWithLimits(user.id);
  return {
    ok: true,
    user: {
      id: user.id,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      country: user.country,
    },
    meta: {
      suspicious: suspiciousInfo.suspicious,
      riskScore: suspiciousInfo.riskScore,
      deviceTrustScore: nextTrustScore,
      kyc,
    },
  };
}

export async function verifyBiometricUnlock(input: {
  userId: string;
  device: DeviceContext;
  unlockToken: string;
}): Promise<{ ok: boolean; reason?: string }> {
  await ensureAuthSchemaReady();
  const [record] = await db
    .select()
    .from(authDeviceTrustTable)
    .where(
      and(
        eq(authDeviceTrustTable.userId, input.userId),
        eq(authDeviceTrustTable.deviceId, input.device.deviceId),
      ),
    )
    .limit(1);
  if (!record) return { ok: false, reason: "Appareil non enregistre." };
  if (!record.biometricEnabled || !record.biometricUnlockHash) {
    return { ok: false, reason: "Biometrie non activee sur cet appareil." };
  }
  const unlockHash = hashValue(input.unlockToken);
  if (unlockHash !== record.biometricUnlockHash) {
    return { ok: false, reason: "Verification biometrie invalide." };
  }
  const kyc = await getKycStatusWithLimits(input.userId);
  await db
    .update(authDeviceTrustTable)
    .set({
      lastLoginAt: new Date(),
      trustScore: Math.min(100, Math.max(20, record.trustScore + 5)),
      updatedAt: new Date(),
    })
    .where(eq(authDeviceTrustTable.id, record.id));
  return { ok: true, user: null as never, meta: { suspicious: false, riskScore: 8, deviceTrustScore: Math.min(100, Math.max(20, record.trustScore + 5)), kyc } } as any;
}

export async function enableBiometricUnlock(input: {
  userId: string;
  device: DeviceContext;
  unlockToken: string;
}): Promise<void> {
  await ensureAuthSchemaReady();
  const record = await getOrCreateDeviceTrust(input.userId, input.device);
  await db
    .update(authDeviceTrustTable)
    .set({
      biometricEnabled: true,
      biometricUnlockHash: hashValue(input.unlockToken),
      updatedAt: new Date(),
    })
    .where(eq(authDeviceTrustTable.id, record.id));
}

export async function getLatestKycSubmission(userId: string) {
  const [row] = await db
    .select({
      id: kycRecordsTable.id,
      status: kycRecordsTable.status,
      kycLevel: kycRecordsTable.kycLevel,
      submittedAt: kycRecordsTable.submittedAt,
      verifiedAt: kycRecordsTable.verifiedAt,
      rejectionReason: kycRecordsTable.rejectionReason,
    })
    .from(kycRecordsTable)
    .where(eq(kycRecordsTable.userId, userId))
    .orderBy(desc(kycRecordsTable.submittedAt))
    .limit(1);
  return row ?? null;
}
