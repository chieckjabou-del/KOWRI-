import { db } from "@workspace/db";
import { adminUsersTable, adminSessionsTable } from "@workspace/db";
import { eq, and, gt, isNull, sql } from "drizzle-orm";
import { randomBytes, createHash, createHmac, scryptSync, timingSafeEqual } from "crypto";
import { generateId } from "./id";
import { encryptField, decryptField } from "./fieldCrypto";

// ── Roles and permissions ─────────────────────────────────────────────────────
//
// Reads on the back-office are open to every admin role; each *write* family is
// gated by one permission. Roles are fixed sets of permissions — there is no
// per-user override, so an auditor can never be granted a money-moving right by
// a typo in the database.

export const PERMISSIONS = [
  "users.read",       // list and inspect product users
  "users.manage",     // change a product user's status
  "kyc.review",       // approve / reject KYC submissions
  "aml.review",       // review AML flags and resolve risk alerts
  "wallets.manage",   // freeze / close / reopen wallets
  "ledger.write",     // credit wallets from platform float, accrue, run schedulers
  "merchants.manage", // activate / suspend merchants
  "support.manage",   // resolve support tickets
  "system.control",   // kill switches, sagas, MQ, regions, failure simulation, webhooks
  "admins.manage",    // create admins, change roles, reset passwords
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  super_admin: PERMISSIONS,
  compliance:  ["users.read", "users.manage", "kyc.review", "aml.review", "wallets.manage"],
  operations:  ["users.read", "wallets.manage", "ledger.write", "merchants.manage", "support.manage"],
  support:     ["users.read", "support.manage"],
  auditor:     ["users.read"],
};
export const ROLES = Object.keys(ROLE_PERMISSIONS);

export function isRole(value: unknown): value is keyof typeof ROLE_PERMISSIONS {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, value);
}

export function permissionsForRole(role: string): Set<Permission> {
  return new Set(ROLE_PERMISSIONS[role] ?? []);
}

// ── Second factor (TOTP, RFC 6238) ────────────────────────────────────────────
//
// Operator accounts move money, approve identities and change fees; a password
// alone is not an acceptable barrier for that. When MFA is enforced
// (ADMIN_MFA_REQUIRED=true, the default in production) a session that has not
// presented a valid code — because the operator never enrolled, or logged in
// without one — keeps read access only: every write permission is stripped
// until the second factor is in place. The shared legacy key, which has no
// second factor at all, is reduced the same way.

export function mfaRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ADMIN_MFA_REQUIRED ?? "").toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return env.NODE_ENV === "production";
}

const READ_ONLY_PERMISSIONS: readonly Permission[] = ["users.read"];

export function effectivePermissions(role: string, mfaVerified: boolean): Set<Permission> {
  const full = permissionsForRole(role);
  if (!mfaRequired() || mfaVerified) return full;
  return new Set(READ_ONLY_PERMISSIONS.filter((p) => full.has(p)));
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of str.replace(/=+$/, "").toUpperCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secretBase32: string, step = Math.floor(Date.now() / 30_000)): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

// Accepts the current 30-second step and one step either side (clock drift).
export function verifyTotp(secretBase32: string, code: unknown): boolean {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 30_000);
  const given = Buffer.from(code);
  for (const step of [now, now - 1, now + 1]) {
    const expected = Buffer.from(totpCode(secretBase32, step));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return true;
  }
  return false;
}

export function totpUri(email: string, secretBase32: string): string {
  const issuer = encodeURIComponent(process.env.MFA_ISSUER ?? "AKWE");
  return `otpauth://totp/${issuer}:${encodeURIComponent(email)}?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

export async function beginMfaEnrollment(adminId: string, email: string): Promise<{ secret: string; uri: string }> {
  const secret = generateTotpSecret();
  await db.update(adminUsersTable)
    .set({ mfaSecret: encryptField(secret), mfaEnabledAt: null, updatedAt: new Date() })
    .where(eq(adminUsersTable.id, adminId));
  return { secret, uri: totpUri(email, secret) };
}

export async function confirmMfaEnrollment(adminId: string, code: unknown): Promise<boolean> {
  const [row] = await db.select({ secret: adminUsersTable.mfaSecret }).from(adminUsersTable).where(eq(adminUsersTable.id, adminId)).limit(1);
  const secret = decryptField(row?.secret);
  if (!secret || !verifyTotp(secret, code)) return false;
  await db.update(adminUsersTable).set({ mfaEnabledAt: new Date(), updatedAt: new Date() }).where(eq(adminUsersTable.id, adminId));
  return true;
}

export async function resetMfa(adminId: string): Promise<void> {
  await db.update(adminUsersTable).set({ mfaSecret: null, mfaEnabledAt: null, updatedAt: new Date() }).where(eq(adminUsersTable.id, adminId));
}

export function adminMfaSecret(row: AdminUserRow): string | null {
  return row.mfaEnabledAt ? decryptField(row.mfaSecret) : null;
}

export async function markSessionMfaVerified(sessionId: string): Promise<void> {
  await db.update(adminSessionsTable).set({ mfaVerified: true }).where(eq(adminSessionsTable.id, sessionId));
}

// ── Passwords ─────────────────────────────────────────────────────────────────

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 1 << 15;
export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST, maxmem: 64 * 1024 * 1024 });
  return `scrypt2$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !storedHash.startsWith("scrypt2$")) return false;
  const [, saltHex, hashHex] = storedHash.split("$");
  if (!saltHex || !hashHex) return false;
  const derived = scryptSync(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN, { N: SCRYPT_COST, maxmem: 64 * 1024 * 1024 });
  const expected = Buffer.from(hashHex, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== "string") return "password must be a string";
  if (password.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return "password must mix letters and digits";
  return null;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export const ADMIN_TOKEN_PREFIX = "kadm_";
const DEFAULT_TTL_HOURS = 12;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type AdminUserRow = typeof adminUsersTable.$inferSelect;

export interface AdminIdentity {
  adminId: string;
  email: string;
  name: string;
  role: string;
  permissions: Set<Permission>;
  sessionId: string | null;
  via: "session" | "legacy_key";
  // False when MFA is enforced and this session has not presented a code:
  // the identity then carries read permissions only.
  mfaVerified: boolean;
  mfaEnrolled: boolean;
}

export function publicAdmin(row: AdminUserRow) {
  return {
    id: row.id, email: row.email, name: row.name, role: row.role, status: row.status,
    permissions: [...permissionsForRole(row.role)],
    mfaEnabled: !!row.mfaEnabledAt, mfaRequired: mfaRequired(),
    mustChangePassword: row.mustChangePassword, lastLoginAt: row.lastLoginAt, createdAt: row.createdAt,
  };
}

export async function createAdminSession(
  adminId: string,
  opts: { ipAddress?: string; userAgent?: string; ttlHours?: number; mfaVerified?: boolean } = {},
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = `${ADMIN_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
  const sessionId = generateId("asess");
  const expiresAt = new Date(Date.now() + (opts.ttlHours ?? DEFAULT_TTL_HOURS) * 3600_000);
  await db.insert(adminSessionsTable).values({
    id: sessionId, adminUserId: adminId, tokenHash: hashToken(token),
    ipAddress: opts.ipAddress, userAgent: opts.userAgent?.slice(0, 300), expiresAt,
    mfaVerified: opts.mfaVerified ?? false,
  });
  return { token, sessionId, expiresAt };
}

export async function validateAdminToken(token: string): Promise<AdminIdentity | null> {
  if (!token.startsWith(ADMIN_TOKEN_PREFIX)) return null;
  const now = new Date();
  const [row] = await db.select({ session: adminSessionsTable, admin: adminUsersTable })
    .from(adminSessionsTable)
    .innerJoin(adminUsersTable, eq(adminUsersTable.id, adminSessionsTable.adminUserId))
    .where(and(
      eq(adminSessionsTable.tokenHash, hashToken(token)),
      gt(adminSessionsTable.expiresAt, now),
      isNull(adminSessionsTable.revokedAt),
    ))
    .limit(1);
  if (!row || row.admin.status !== "active") return null;

  await db.update(adminSessionsTable).set({ lastUsedAt: now }).where(eq(adminSessionsTable.id, row.session.id));
  const mfaVerified = row.session.mfaVerified && !!row.admin.mfaEnabledAt;
  return {
    adminId: row.admin.id, email: row.admin.email, name: row.admin.name, role: row.admin.role,
    permissions: effectivePermissions(row.admin.role, mfaVerified), sessionId: row.session.id, via: "session",
    mfaVerified, mfaEnrolled: !!row.admin.mfaEnabledAt,
  };
}

export async function revokeAdminSessionByToken(token: string): Promise<void> {
  await db.update(adminSessionsTable).set({ revokedAt: new Date() })
    .where(and(eq(adminSessionsTable.tokenHash, hashToken(token)), isNull(adminSessionsTable.revokedAt)));
}

export async function revokeAdminSession(sessionId: string, adminId: string): Promise<boolean> {
  const rows = await db.update(adminSessionsTable).set({ revokedAt: new Date() })
    .where(and(eq(adminSessionsTable.id, sessionId), eq(adminSessionsTable.adminUserId, adminId), isNull(adminSessionsTable.revokedAt)))
    .returning({ id: adminSessionsTable.id });
  return rows.length > 0;
}

export async function revokeAllAdminSessions(adminId: string, exceptSessionId?: string): Promise<number> {
  const rows = await db.update(adminSessionsTable).set({ revokedAt: new Date() })
    .where(and(
      eq(adminSessionsTable.adminUserId, adminId),
      isNull(adminSessionsTable.revokedAt),
      exceptSessionId ? sql`${adminSessionsTable.id} <> ${exceptSessionId}` : sql`true`,
    ))
    .returning({ id: adminSessionsTable.id });
  return rows.length;
}

export async function countAdmins(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(adminUsersTable);
  return row?.n ?? 0;
}

export async function createAdminUser(input: {
  email: string; name: string; password: string; role: string; createdBy?: string; mustChangePassword?: boolean;
}): Promise<AdminUserRow> {
  const [row] = await db.insert(adminUsersTable).values({
    id: generateId("adm"),
    email: input.email.trim().toLowerCase(),
    name: input.name.trim(),
    passwordHash: hashPassword(input.password),
    role: input.role,
    createdBy: input.createdBy,
    mustChangePassword: input.mustChangePassword ?? false,
  }).returning();
  return row;
}

// First super-admin on an empty table, from ADMIN_BOOTSTRAP_EMAIL / ADMIN_BOOTSTRAP_PASSWORD.
// Runs at boot only; once one admin exists the variables are ignored and should be removed.
export async function bootstrapAdminFromEnv(): Promise<void> {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!email || !password) return;
  if ((await countAdmins()) > 0) {
    console.warn("[admin] ADMIN_BOOTSTRAP_* is set but admin accounts already exist — remove these variables");
    return;
  }
  const policy = passwordPolicyError(password);
  if (policy) { console.error(`[admin] bootstrap refused: ${policy}`); return; }
  await createAdminUser({ email, name: process.env.ADMIN_BOOTSTRAP_NAME ?? "Bootstrap admin", password, role: "super_admin", createdBy: "bootstrap", mustChangePassword: true });
  console.log(`[admin] Bootstrap super_admin created for ${email.toLowerCase()} (password change required at first login)`);
}
