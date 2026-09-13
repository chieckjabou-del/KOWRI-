import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { adminUsersTable, adminSessionsTable } from "@workspace/db";
import { eq, and, isNull, desc } from "drizzle-orm";
import { loginRateLimit } from "../lib/loginRateLimit";
import { audit } from "../lib/auditLogger";
import { requireAdmin, requirePermission, resolveAdmin } from "../middleware/auth";
import { routeParamString } from "../lib/routeParams";
import {
  ROLES, ROLE_PERMISSIONS, isRole, publicAdmin, hashPassword, verifyPassword, passwordPolicyError,
  createAdminSession, validateAdminToken, revokeAdminSessionByToken, revokeAdminSession, revokeAllAdminSessions,
  countAdmins, createAdminUser, ADMIN_TOKEN_PREFIX,
  mfaRequired, adminMfaSecret, verifyTotp, beginMfaEnrollment, confirmMfaEnrollment, resetMfa, markSessionMfaVerified,
} from "../lib/adminAuth";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function presentedToken(req: Request): string | null {
  const header = req.headers["x-admin-token"];
  if (typeof header === "string" && header.startsWith(ADMIN_TOKEN_PREFIX)) return header;
  const m = String(req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
  return m && m[1].startsWith(ADMIN_TOKEN_PREFIX) ? m[1] : null;
}

// Account-bound routes (me, logout, password change, sessions) need a real session,
// not the shared legacy key, which has no account to act on.
async function requireAdminSession(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = await resolveAdmin(req);
    if (!admin || admin.via !== "session") {
      res.status(401).json({ error: "Admin session required" });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ── Public: login only ────────────────────────────────────────────────────────

router.get("/roles", requireAdmin, (_req, res) => {
  res.json({ roles: ROLES.map((role) => ({ role, permissions: ROLE_PERMISSIONS[role] })) });
});

router.post("/login", loginRateLimit, async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = req.body?.password;
    if (!email || typeof password !== "string") {
      return res.status(400).json({ error: "email and password required" });
    }
    const [admin] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.email, email)).limit(1);
    if (!admin || !verifyPassword(password, admin.passwordHash)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (admin.status !== "active") {
      return res.status(403).json({ error: "Account disabled" });
    }
    // Enrolled operators must present their code with the password; the
    // session is then fully privileged. Without enrolment the session is
    // created but, when MFA is enforced, carries read permissions only.
    const secret = adminMfaSecret(admin);
    let mfaVerified = false;
    if (secret) {
      const code = req.body?.totpCode;
      if (code === undefined || code === null || code === "") {
        return res.status(401).json({ error: "Second factor required", code: "MFA_REQUIRED" });
      }
      if (!verifyTotp(secret, String(code))) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      mfaVerified = true;
    }
    const session = await createAdminSession(admin.id, { ipAddress: req.ip, userAgent: req.headers["user-agent"], mfaVerified });
    await db.update(adminUsersTable).set({ lastLoginAt: new Date() }).where(eq(adminUsersTable.id, admin.id));
    await audit({ action: "admin.login", entity: "admin_user", entityId: admin.id, actor: admin.email, metadata: { ip: req.ip, sessionId: session.sessionId, mfaVerified } });
    return res.json({
      token: session.token, expiresAt: session.expiresAt, admin: publicAdmin(admin),
      mfaVerified, mfaEnrollmentRequired: mfaRequired() && !secret,
    });
  } catch (err) {
    return next(err);
  }
});

// First super_admin. Allowed only while no admin account exists, and only with the
// shared key as proof that the caller already operates the platform.
router.post("/bootstrap", requireAdmin, async (req, res, next) => {
  try {
    if ((await countAdmins()) > 0) {
      return res.status(409).json({ error: "Admin accounts already exist; use an admins.manage session to add more" });
    }
    const { email, name, password } = req.body ?? {};
    if (typeof email !== "string" || !EMAIL_RE.test(email) || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "email and name required" });
    }
    const policy = passwordPolicyError(password);
    if (policy) return res.status(400).json({ error: policy });
    const admin = await createAdminUser({ email, name, password, role: "super_admin", createdBy: "bootstrap" });
    await audit({ action: "admin.bootstrap", entity: "admin_user", entityId: admin.id, actor: admin.email, metadata: { ip: req.ip } });
    return res.status(201).json({ admin: publicAdmin(admin) });
  } catch (err) {
    return next(err);
  }
});

// ── Own account ───────────────────────────────────────────────────────────────

router.get("/me", requireAdminSession, async (req, res, next) => {
  try {
    const [admin] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.id, req.admin!.adminId)).limit(1);
    if (!admin) return res.status(404).json({ error: "Admin not found" });
    return res.json({ admin: publicAdmin(admin), sessionId: req.admin!.sessionId });
  } catch (err) {
    return next(err);
  }
});

router.post("/logout", requireAdminSession, async (req, res, next) => {
  try {
    const token = presentedToken(req);
    if (token) await revokeAdminSessionByToken(token);
    await audit({ action: "admin.logout", entity: "admin_user", entityId: req.admin!.adminId, actor: req.admin!.email });
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.post("/change-password", requireAdminSession, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    const [admin] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.id, req.admin!.adminId)).limit(1);
    if (!admin || typeof currentPassword !== "string" || !verifyPassword(currentPassword, admin.passwordHash)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    const policy = passwordPolicyError(newPassword);
    if (policy) return res.status(400).json({ error: policy });
    if (newPassword === currentPassword) return res.status(400).json({ error: "New password must differ from the current one" });
    await db.update(adminUsersTable)
      .set({ passwordHash: hashPassword(newPassword), mustChangePassword: false, updatedAt: new Date() })
      .where(eq(adminUsersTable.id, admin.id));
    // Every other session of this account is closed: a stolen token dies with the old password.
    const revoked = await revokeAllAdminSessions(admin.id, req.admin!.sessionId ?? undefined);
    await audit({ action: "admin.password.changed", entity: "admin_user", entityId: admin.id, actor: admin.email, metadata: { otherSessionsRevoked: revoked } });
    return res.json({ success: true, otherSessionsRevoked: revoked });
  } catch (err) {
    return next(err);
  }
});

// ── Second factor ─────────────────────────────────────────────────────────────

// Starts (or restarts) enrolment: returns the secret and otpauth URI for an
// authenticator app. Nothing is enforced until /mfa/confirm succeeds.
router.post("/mfa/setup", requireAdminSession, async (req, res, next) => {
  try {
    const { secret, uri } = await beginMfaEnrollment(req.admin!.adminId, req.admin!.email);
    return res.json({ secret, uri, message: "Scan the URI with an authenticator app, then POST /admin/auth/mfa/confirm with a code" });
  } catch (err) {
    return next(err);
  }
});

router.post("/mfa/confirm", requireAdminSession, loginRateLimit, async (req, res, next) => {
  try {
    const ok = await confirmMfaEnrollment(req.admin!.adminId, String(req.body?.code ?? ""));
    if (!ok) return res.status(401).json({ error: "Invalid code" });
    if (req.admin!.sessionId) await markSessionMfaVerified(req.admin!.sessionId);
    await audit({ action: "admin.mfa.enrolled", entity: "admin_user", entityId: req.admin!.adminId, actor: req.admin!.email });
    return res.json({ success: true, mfaEnabled: true });
  } catch (err) {
    return next(err);
  }
});

// Lost authenticator: an admins.manage operator clears the factor; every
// session of the account is closed and the operator must enrol again.
router.post("/users/:adminId/mfa/reset", requirePermission("admins.manage"), async (req, res, next) => {
  try {
    const adminId = routeParamString(req, "adminId")!;
    const [target] = await db.select({ id: adminUsersTable.id }).from(adminUsersTable).where(eq(adminUsersTable.id, adminId)).limit(1);
    if (!target) return res.status(404).json({ error: "Admin not found" });
    await resetMfa(adminId);
    const revoked = await revokeAllAdminSessions(adminId);
    await audit({ action: "admin.mfa.reset", entity: "admin_user", entityId: adminId, actor: req.admin!.email, metadata: { sessionsRevoked: revoked } });
    return res.json({ success: true, sessionsRevoked: revoked });
  } catch (err) {
    return next(err);
  }
});

router.get("/sessions", requireAdminSession, async (req, res, next) => {
  try {
    const rows = await db.select({
      id: adminSessionsTable.id, ipAddress: adminSessionsTable.ipAddress, userAgent: adminSessionsTable.userAgent,
      createdAt: adminSessionsTable.createdAt, lastUsedAt: adminSessionsTable.lastUsedAt, expiresAt: adminSessionsTable.expiresAt,
    }).from(adminSessionsTable)
      .where(and(eq(adminSessionsTable.adminUserId, req.admin!.adminId), isNull(adminSessionsTable.revokedAt)))
      .orderBy(desc(adminSessionsTable.lastUsedAt));
    return res.json({ sessions: rows.map((s) => ({ ...s, current: s.id === req.admin!.sessionId })) });
  } catch (err) {
    return next(err);
  }
});

router.delete("/sessions/:sessionId", requireAdminSession, async (req, res, next) => {
  try {
    const sessionId = routeParamString(req, "sessionId")!;
    const ok = await revokeAdminSession(sessionId, req.admin!.adminId);
    if (!ok) return res.status(404).json({ error: "Session not found" });
    await audit({ action: "admin.session.revoked", entity: "admin_session", entityId: sessionId, actor: req.admin!.email });
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ── Account management (admins.manage) ────────────────────────────────────────

router.get("/users", requirePermission("admins.manage"), async (_req, res, next) => {
  try {
    const rows = await db.select().from(adminUsersTable).orderBy(desc(adminUsersTable.createdAt));
    return res.json({ admins: rows.map(publicAdmin), total: rows.length });
  } catch (err) {
    return next(err);
  }
});

router.post("/users", requirePermission("admins.manage"), async (req, res, next) => {
  try {
    const { email, name, password, role } = req.body ?? {};
    if (typeof email !== "string" || !EMAIL_RE.test(email) || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "email and name required" });
    }
    if (!isRole(role)) return res.status(400).json({ error: `role must be one of ${ROLES.join(", ")}` });
    const policy = passwordPolicyError(password);
    if (policy) return res.status(400).json({ error: policy });
    const [existing] = await db.select({ id: adminUsersTable.id }).from(adminUsersTable).where(eq(adminUsersTable.email, email.trim().toLowerCase())).limit(1);
    if (existing) return res.status(409).json({ error: "An admin with this email already exists" });
    const admin = await createAdminUser({ email, name, password, role, createdBy: req.admin!.adminId, mustChangePassword: true });
    await audit({ action: "admin.account.created", entity: "admin_user", entityId: admin.id, actor: req.admin!.email, metadata: { email: admin.email, role } });
    return res.status(201).json({ admin: publicAdmin(admin) });
  } catch (err) {
    return next(err);
  }
});

router.patch("/users/:adminId", requirePermission("admins.manage"), async (req, res, next) => {
  try {
    const adminId = routeParamString(req, "adminId")!;
    const { role, status, name } = req.body ?? {};
    const [target] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.id, adminId)).limit(1);
    if (!target) return res.status(404).json({ error: "Admin not found" });

    const updates: Partial<typeof adminUsersTable.$inferInsert> = { updatedAt: new Date() };
    if (role !== undefined) {
      if (!isRole(role)) return res.status(400).json({ error: `role must be one of ${ROLES.join(", ")}` });
      updates.role = role;
    }
    if (status !== undefined) {
      if (status !== "active" && status !== "disabled") return res.status(400).json({ error: "status must be active or disabled" });
      updates.status = status;
    }
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name must be a non-empty string" });
      updates.name = name.trim();
    }
    // Nobody can lock the platform out of its last super_admin, including themselves.
    const demotes = (updates.role !== undefined && updates.role !== "super_admin") || updates.status === "disabled";
    if (target.role === "super_admin" && target.status === "active" && demotes) {
      const others = await db.select({ id: adminUsersTable.id }).from(adminUsersTable)
        .where(and(eq(adminUsersTable.role, "super_admin"), eq(adminUsersTable.status, "active")));
      if (others.filter((a) => a.id !== target.id).length === 0) {
        return res.status(409).json({ error: "Cannot demote or disable the last active super_admin" });
      }
    }

    const [updated] = await db.update(adminUsersTable).set(updates).where(eq(adminUsersTable.id, adminId)).returning();
    if (updates.status === "disabled" || (updates.role !== undefined && updates.role !== target.role)) {
      await revokeAllAdminSessions(adminId);
    }
    await audit({ action: "admin.account.updated", entity: "admin_user", entityId: adminId, actor: req.admin!.email,
      metadata: { before: { role: target.role, status: target.status }, after: { role: updated.role, status: updated.status } } });
    return res.json({ admin: publicAdmin(updated) });
  } catch (err) {
    return next(err);
  }
});

router.post("/users/:adminId/reset-password", requirePermission("admins.manage"), async (req, res, next) => {
  try {
    const adminId = routeParamString(req, "adminId")!;
    const { password } = req.body ?? {};
    const policy = passwordPolicyError(password);
    if (policy) return res.status(400).json({ error: policy });
    const [target] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.id, adminId)).limit(1);
    if (!target) return res.status(404).json({ error: "Admin not found" });
    await db.update(adminUsersTable)
      .set({ passwordHash: hashPassword(password), mustChangePassword: true, updatedAt: new Date() })
      .where(eq(adminUsersTable.id, adminId));
    const revoked = await revokeAllAdminSessions(adminId);
    await audit({ action: "admin.password.reset", entity: "admin_user", entityId: adminId, actor: req.admin!.email, metadata: { sessionsRevoked: revoked } });
    return res.json({ success: true, sessionsRevoked: revoked });
  } catch (err) {
    return next(err);
  }
});

// Token introspection for tooling: is this token still valid, and as whom?
router.get("/introspect", async (req, res, next) => {
  try {
    const token = presentedToken(req);
    const identity = token ? await validateAdminToken(token) : null;
    if (!identity) return res.status(401).json({ active: false });
    return res.json({ active: true, adminId: identity.adminId, email: identity.email, role: identity.role, permissions: [...identity.permissions], mfaVerified: identity.mfaVerified, mfaEnrolled: identity.mfaEnrolled });
  } catch (err) {
    return next(err);
  }
});

export default router;
