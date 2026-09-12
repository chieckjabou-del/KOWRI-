import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { db } from "@workspace/db";
import { walletsTable, merchantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../lib/productAuth";

export interface AuthContext {
  userId: string;
  sessionId: string;
  type: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function authenticate(allowedTypes?: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = await requireAuth(req.headers.authorization, allowedTypes);
      if (!auth) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      req.auth = auth;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Internal/admin surface is gated by a shared secret until a real role model exists.
// Fails closed when ADMIN_API_KEY is not configured.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.ADMIN_API_KEY;
  const provided = req.headers["x-admin-key"];

  if (!configured || typeof provided !== "string") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const a = Buffer.from(configured);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  next();
}

export function isAdminRequest(req: Request): boolean {
  const configured = process.env.ADMIN_API_KEY;
  const provided = req.headers["x-admin-key"];
  if (!configured || typeof provided !== "string") return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
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
