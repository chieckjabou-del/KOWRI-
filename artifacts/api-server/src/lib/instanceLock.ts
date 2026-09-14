// ── Cross-instance mutual exclusion ─────────────────────────────────────────
// Background jobs (tontine scheduler, agent reconciliation, wallet
// reconciliation) run on a timer inside the API process. With two or more
// instances behind a load balancer they would all fire; a PostgreSQL advisory
// lock scoped to one transaction lets exactly one instance run each job per tick
// while the others skip it. The lock is released automatically when the
// transaction ends, so a crashed instance never leaves a stale lock behind.

import { createHash } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

function lockKey(name: string): bigint {
  // First 8 bytes of a sha256, as a signed 64-bit key for pg_try_advisory_xact_lock.
  return createHash("sha256").update(name).digest().readBigInt64BE(0);
}

export async function withInstanceLock(name: string, fn: () => Promise<void>): Promise<boolean> {
  const key = lockKey(name);
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${key}) AS acquired`);
    const row = (result as any).rows?.[0] ?? (Array.isArray(result) ? (result as any)[0] : undefined);
    if (!row?.acquired) return false;
    await fn();
    return true;
  });
}
