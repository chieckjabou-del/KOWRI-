import { db } from "@workspace/db";
import { productSessionsTable } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";
import { generateId } from "./id";
import { signAccessToken, verifyAccessToken } from "./authTokens";

export async function createSession(
  userId: string,
  type: "wallet" | "merchant" | "developer" = "wallet",
  opts: { deviceId?: string; ipAddress?: string; ttlHours?: number } = {}
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const sessionId  = generateId("sess");
  const ttl        = opts.ttlHours ?? 24;
  const ttlSeconds = Math.max(1, Math.floor(ttl * 3600));
  const token      = signAccessToken({ sub: userId, type, sid: sessionId }, ttlSeconds);
  const expiresAt  = new Date(Date.now() + ttl * 3600_000);

  await db.insert(productSessionsTable).values({
    id:        sessionId,
    userId,
    token,
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
  const claims = verifyAccessToken(token);
  if (!claims) return { valid: false };

  const now = new Date();
  const rows = await db.select()
    .from(productSessionsTable)
    .where(and(
      eq(productSessionsTable.token, token),
      gt(productSessionsTable.expiresAt, now),
    ))
    .limit(1);

  if (!rows[0]) return { valid: false };
  if (rows[0].id !== claims.sid || rows[0].userId !== claims.sub || rows[0].type !== claims.type) {
    return { valid: false };
  }

  await db.update(productSessionsTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(productSessionsTable.id, rows[0].id));

  return { valid: true, userId: rows[0].userId, sessionId: rows[0].id, type: rows[0].type };
}

export async function revokeSession(token: string): Promise<boolean> {
  const result = await db.delete(productSessionsTable)
    .where(eq(productSessionsTable.token, token));
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
