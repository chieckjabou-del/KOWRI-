import { db } from "@workspace/db";
import {
  productSessionsTable,
} from "@workspace/db";
import { eq, and, gt, or } from "drizzle-orm";
import { randomBytes, createHash } from "crypto";
import { generateId } from "./id";

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  type: "wallet" | "merchant" | "developer" = "wallet",
  opts: { deviceId?: string; ipAddress?: string; ttlHours?: number } = {}
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token      = generateToken();
  const tokenHash  = hashToken(token);
  const sessionId  = generateId("sess");
  const ttl        = opts.ttlHours ?? 24;
  const expiresAt  = new Date(Date.now() + ttl * 3600_000);

  await db.insert(productSessionsTable).values({
    id:        sessionId,
    userId,
    token: tokenHash,
    type,
    deviceId:  opts.deviceId,
    ipAddress: opts.ipAddress,
    expiresAt,
    lastUsedAt: new Date(),
  });

  return { token, sessionId, expiresAt };
}

export async function validateSession(token: string): Promise<{
  valid: boolean;
  userId?: string;
  sessionId?: string;
  type?: string;
}> {
  const tokenHash = hashToken(token);
  const now = new Date();
  let rows = await db.select()
    .from(productSessionsTable)
    .where(and(
      eq(productSessionsTable.token, tokenHash),
      gt(productSessionsTable.expiresAt, now),
    ))
    .limit(1);

  // Backward compatibility: legacy rows may still store plaintext token.
  if (!rows[0]) {
    rows = await db.select()
      .from(productSessionsTable)
      .where(and(
        eq(productSessionsTable.token, token),
        gt(productSessionsTable.expiresAt, now),
      ))
      .limit(1);

    if (rows[0]) {
      await db.update(productSessionsTable)
        .set({ token: tokenHash, lastUsedAt: new Date() })
        .where(eq(productSessionsTable.id, rows[0].id));
    }
  }

  if (!rows[0]) return { valid: false };

  await db.update(productSessionsTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(productSessionsTable.id, rows[0].id));

  return { valid: true, userId: rows[0].userId, sessionId: rows[0].id, type: rows[0].type };
}

export async function revokeSession(token: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const result = await db.delete(productSessionsTable)
    .where(or(
      eq(productSessionsTable.token, tokenHash),
      eq(productSessionsTable.token, token),
    ));
  return true;
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await db.delete(productSessionsTable).where(eq(productSessionsTable.userId, userId));
}

export function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export async function requireAuth(
  authHeader: string | undefined,
  allowedTypes?: string[]
): Promise<{ userId: string; sessionId: string; type: string } | null> {
  const token = extractBearerToken(authHeader);
  if (!token) return null;
  const session = await validateSession(token);
  if (!session.valid || !session.userId) return null;
  if (allowedTypes && !allowedTypes.includes(session.type!)) return null;
  return { userId: session.userId, sessionId: session.sessionId!, type: session.type! };
}
