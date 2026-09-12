import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { db } from "@workspace/db";
import { walletsTable, merchantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, extractBearerToken } from "../lib/productAuth";
import {
  validateAdminToken, permissionsForRole, ADMIN_TOKEN_PREFIX,
  type AdminIdentity, type Permission,
} from "../lib/adminAuth";

export interface AuthContext {
  userId: string;
  sessionId: string;
  type: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      admin?: AdminIdentity;
      adminResolved?: boolean;
    }
  }
}

// ── Admin identity resolution ─────────────────────────────────────────────────
//
// An operator authenticates with an admin session token, sent either as
// `X-Admin-Token` or as `Authorization: Bearer kadm_…`. The shared
// `ADMIN_API_KEY` (`X-Admin-Key`) is still honoured as a legacy super-admin
// credential so existing tooling keeps working during the migration; unset the
// variable once every operator has an account (see docs/SECURITY_SECRETS.md).

function legacyKeyMatches(req: Request): boolean {
  const configured = process.env.ADMIN_API_KEY;
  const provided = req.headers["x-admin-key"];
  if (!configured || typeof provided !== "string") return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function legacyIdentity(): AdminIdentity {
  return {
    adminId: "legacy-key", email: "legacy-key@local", name: "Shared admin key", role: "super_admin",
    permissions: permissionsForRole("super_admin"), sessionId: null, via: "legacy_key",
  };
}

function adminTokenFrom(req: Request): string | null {
  const header = req.headers["x-admin-token"];
  if (typeof header === "string" && header.startsWith(ADMIN_TOKEN_PREFIX)) return header;
  const bearer = extractBearerToken(req.headers.authorization);
  if (bearer && bearer.startsWith(ADMIN_TOKEN_PREFIX)) return bearer;
  return null;
}

export async function resolveAdmin(req: Request): Promise<AdminIdentity | null> {
  if (req.adminResolved) return req.admin ?? null;
  req.adminResolved = true;
  const token = adminTokenFrom(req);
  if (token) {
    const identity = await validateAdminToken(token);
    if (identity) { req.admin = identity; return identity; }
  }
  if (legacyKeyMatches(req)) { req.admin = legacyIdentity(); return req.admin; }
  return null;
}

// ── Product sessions ──────────────────────────────────────────────────────────

export function authenticate(allowedTypes?: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const admin = await resolveAdmin(req);
      const auth = await requireAuth(req.headers.authorization, allowedTypes);
      if (auth) {
        req.auth = auth;
        next();
        return;
      }
      // An operator without a product session may still reach these routes when the
      // route itself allows admins (requireSelfOrAdmin, isAdminRequest); the pseudo
      // user id is the admin id, which never matches a wallet owner.
      if (admin && (!allowedTypes || allowedTypes.includes("admin"))) {
        req.auth = { userId: admin.adminId, sessionId: admin.sessionId ?? "legacy-key", type: "admin" };
        next();
        return;
      }
      res.status(401).json({ error: "Authentication required" });
    } catch (err) {
      next(err);
    }
  };
}

// ── Admin gates ───────────────────────────────────────────────────────────────

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const admin = await resolveAdmin(req);
      if (!admin) {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
      if (!admin.permissions.has(permission)) {
        res.status(403).json({ error: "Insufficient permissions", code: "PERMISSION_DENIED", required: permission, role: admin.role });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Reads stay open to every admin role; anything that mutates state needs the permission.
export function gateWrites(permission: Permission) {
  const check = requirePermission(permission);
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") { next(); return; }
    return check(req, res, next);
  };
}

export function isAdminRequest(req: Request): boolean {
  if (req.admin) return true;
  if (req.adminResolved) return false;
  // Route reached without authenticate()/requireAdmin(): only the synchronous legacy key can be checked.
  return legacyKeyMatches(req);
}

export function adminActor(req: Request, fallback?: unknown): string {
  if (req.admin) return req.admin.via === "session" ? req.admin.email : "legacy-key";
  return typeof fallback === "string" && fallback ? fallback : "unknown";
}

export function requireSelfOrAdmin(paramName = "userId") {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isAdminRequest(req)) { next(); return; }
    if (!req.auth || req.auth.userId !== req.params[paramName]) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

export async function walletBelongsToUser(walletId: string, userId: string): Promise<boolean> {
  const [wallet] = await db
    .select({ userId: walletsTable.userId })
    .from(walletsTable)
    .where(eq(walletsTable.id, walletId))
    .limit(1);
  return !!wallet && wallet.userId === userId;
}

export async function merchantBelongsToUser(merchantId: string, userId: string): Promise<boolean> {
  const [merchant] = await db
    .select({ userId: merchantsTable.userId })
    .from(merchantsTable)
    .where(eq(merchantsTable.id, merchantId))
    .limit(1);
  return !!merchant && merchant.userId === userId;
}
