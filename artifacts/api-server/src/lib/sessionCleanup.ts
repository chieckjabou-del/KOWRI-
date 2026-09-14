// ── Session housekeeping ─────────────────────────────────────────────────────
// Product and operator sessions are never deleted when they expire or are
// revoked, so the tables grow forever. A daily job removes rows that have been
// dead for longer than the retention window (kept a few days for audit).

import { db } from "@workspace/db";
import { productSessionsTable, adminSessionsTable } from "@workspace/db";
import { lt, or, and, isNotNull } from "drizzle-orm";
import { purgeOldVerifications } from "./phoneVerification";

const RETENTION_DAYS = Number(process.env.SESSION_RETENTION_DAYS ?? 7);

export async function purgeExpiredSessions(): Promise<{ product: number; admin: number; verifications: number }> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3_600_000);
  const product = await db.delete(productSessionsTable)
    .where(lt(productSessionsTable.expiresAt, cutoff))
    .returning({ id: productSessionsTable.id });
  const admin = await db.delete(adminSessionsTable)
    .where(or(
      lt(adminSessionsTable.expiresAt, cutoff),
      and(isNotNull(adminSessionsTable.revokedAt), lt(adminSessionsTable.revokedAt, cutoff)),
    ))
    .returning({ id: adminSessionsTable.id });
  const verifications = await purgeOldVerifications();
  const result = { product: product.length, admin: admin.length, verifications };
  if (result.product || result.admin || result.verifications) console.log("[SessionCleanup]", result);
  return result;
}
