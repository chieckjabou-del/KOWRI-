// ── Phone verification (OTP) ─────────────────────────────────────────────────
// Registration is gated on proof that the caller controls the phone number:
//   1. POST /auth/otp/request  → 6-digit code sent by SMS (10 min, 5 tries)
//   2. POST /auth/otp/verify   → short-lived verification token (15 min)
//   3. registration route      → consumes the token once
// PHONE_VERIFICATION: "required" (default in production) or "optional" (default
// elsewhere: a token is validated when present, registration works without).

import { createHmac, randomBytes, randomInt } from "crypto";
import { db } from "@workspace/db";
import { phoneVerificationsTable } from "@workspace/db";
import { and, eq, gt, isNull, desc, sql } from "drizzle-orm";
import { generateId } from "./id";
import { sendSms } from "./sms";

const CODE_TTL_MS = 10 * 60_000;
const TOKEN_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_REQUESTS_PER_HOUR = 5;

export class PhoneVerificationError extends Error {
  constructor(message: string, public readonly code: string, public readonly status = 400) {
    super(message);
    this.name = "PhoneVerificationError";
  }
}

export function verificationMode(): "required" | "optional" {
  const mode = (process.env.PHONE_VERIFICATION ?? "").toLowerCase();
  if (mode === "required" || mode === "optional") return mode;
  return process.env.NODE_ENV === "production" ? "required" : "optional";
}

export function normalizePhone(phone: string): string {
  return String(phone).replace(/[\s().-]/g, "");
}

function digest(value: string): string {
  return createHmac("sha256", process.env.SIGNING_SECRET ?? "kowri-dev").update(value).digest("hex");
}

export async function requestVerification(phone: string, purpose = "registration", requestIp?: string): Promise<{ expiresAt: Date; devCode?: string }> {
  const normalized = normalizePhone(phone);
  if (!/^\+?\d{8,15}$/.test(normalized)) throw new PhoneVerificationError("Numéro de téléphone invalide", "INVALID_PHONE");

  const oneHourAgo = new Date(Date.now() - 3_600_000);
  const [{ recent }] = await db.select({ recent: sql<number>`COUNT(*)::int` }).from(phoneVerificationsTable)
    .where(and(eq(phoneVerificationsTable.phone, normalized), gt(phoneVerificationsTable.createdAt, oneHourAgo)));
  if (Number(recent) >= MAX_REQUESTS_PER_HOUR) {
    throw new PhoneVerificationError("Trop de demandes de code pour ce numéro, réessayez plus tard", "OTP_RATE_LIMITED", 429);
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await db.insert(phoneVerificationsTable).values({
    id: generateId("otp"), phone: normalized, purpose, codeHash: digest(`${normalized}:${code}`), expiresAt, requestIp: requestIp ?? null,
  });
  await sendSms(normalized, `KOWRI : votre code de vérification est ${code}. Il expire dans 10 minutes.`);

  return { expiresAt, ...(process.env.NODE_ENV !== "production" ? { devCode: code } : {}) };
}

export async function verifyCode(phone: string, code: string, purpose = "registration"): Promise<{ verificationToken: string; expiresAt: Date }> {
  const normalized = normalizePhone(phone);
  const [pending] = await db.select().from(phoneVerificationsTable)
    .where(and(
      eq(phoneVerificationsTable.phone, normalized),
      eq(phoneVerificationsTable.purpose, purpose),
      isNull(phoneVerificationsTable.verifiedAt),
      gt(phoneVerificationsTable.expiresAt, new Date()),
    ))
    .orderBy(desc(phoneVerificationsTable.createdAt))
    .limit(1);
  if (!pending) throw new PhoneVerificationError("Aucun code en cours pour ce numéro, demandez-en un nouveau", "OTP_NOT_FOUND");
  if (pending.attempts >= MAX_ATTEMPTS) throw new PhoneVerificationError("Trop de tentatives, demandez un nouveau code", "OTP_LOCKED", 429);

  if (digest(`${normalized}:${String(code).trim()}`) !== pending.codeHash) {
    await db.update(phoneVerificationsTable).set({ attempts: pending.attempts + 1 }).where(eq(phoneVerificationsTable.id, pending.id));
    throw new PhoneVerificationError("Code incorrect", "OTP_INVALID");
  }

  const token = `pv_${randomBytes(24).toString("hex")}`;
  const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await db.update(phoneVerificationsTable)
    .set({ verifiedAt: new Date(), tokenHash: digest(token), tokenExpiresAt })
    .where(eq(phoneVerificationsTable.id, pending.id));
  return { verificationToken: token, expiresAt: tokenExpiresAt };
}

// Consumes the token for this phone. Returns null when registration may go on,
// or the error to answer with. Registration routes call this before inserting.
export async function consumeVerification(phone: string, token: unknown, purpose = "registration"): Promise<PhoneVerificationError | null> {
  const mode = verificationMode();
  const normalized = normalizePhone(phone);
  if (typeof token !== "string" || !token) {
    return mode === "required"
      ? new PhoneVerificationError("Vérification du téléphone requise : demandez un code, puis fournissez verificationToken", "PHONE_VERIFICATION_REQUIRED", 403)
      : null;
  }
  const consumed = await db.update(phoneVerificationsTable)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(phoneVerificationsTable.phone, normalized),
      eq(phoneVerificationsTable.purpose, purpose),
      eq(phoneVerificationsTable.tokenHash, digest(token)),
      isNull(phoneVerificationsTable.consumedAt),
      gt(phoneVerificationsTable.tokenExpiresAt, new Date()),
    ))
    .returning({ id: phoneVerificationsTable.id });
  if (!consumed.length) return new PhoneVerificationError("verificationToken invalide, expiré ou déjà utilisé pour ce numéro", "PHONE_VERIFICATION_INVALID", 403);
  return null;
}

// Housekeeping: codes and tokens are useless after a day.
export async function purgeOldVerifications(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 3_600_000);
  const rows = await db.delete(phoneVerificationsTable).where(sql`${phoneVerificationsTable.createdAt} < ${cutoff}`).returning({ id: phoneVerificationsTable.id });
  return rows.length;
}
