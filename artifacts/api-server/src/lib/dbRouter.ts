import { db, createReplicaDb } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Config ────────────────────────────────────────────────────────────────────
const REPLICA_URL      = process.env.DATABASE_REPLICA_URL;
const REPLICA_ENABLED  = process.env.READ_REPLICA_ENABLED === "true" && !!REPLICA_URL;
const LAG_THRESHOLD_S  = Number(process.env.REPLICA_LAG_THRESHOLD_S  ?? 5);
const LAG_POLL_MS      = Number(process.env.REPLICA_LAG_POLL_MS      ?? 10_000);
export const STICKY_MS = Number(process.env.STICKY_PRIMARY_MS        ?? 7_000);

// ── Replica client ────────────────────────────────────────────────────────────
// When no replica URL is configured, dbRead aliases the primary — zero overhead.
let dbRead: ReturnType<typeof createReplicaDb> | typeof db = db;

if (REPLICA_ENABLED && REPLICA_URL) {
  dbRead = createReplicaDb(REPLICA_URL);
  console.log("[DbRouter] Read replica enabled");
} else {
  console.log("[DbRouter] No replica configured — reads route to primary");
}

// ── Lag monitor ───────────────────────────────────────────────────────────────
let replicaHealthy = true;
let lastLagSec     = 0;

async function pollReplicaLag(): Promise<void> {
  if (!REPLICA_ENABLED) return;
  try {
    const result = await (dbRead as any).execute<{ lag_sec: string }>(
      sql`SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::numeric AS lag_sec`,
    );
    const lag      = Number(result.rows?.[0]?.lag_sec ?? 0);
    lastLagSec     = lag;
    replicaHealthy = lag <= LAG_THRESHOLD_S;
    if (!replicaHealthy) {
      console.warn(`[DbRouter] Replica lag ${lag.toFixed(1)}s > threshold ${LAG_THRESHOLD_S}s — routing reads to primary`);
    }
  } catch (err) {
    replicaHealthy = false;
    console.error("[DbRouter] Replica lag poll failed — routing reads to primary:", err);
  }
}

if (REPLICA_ENABLED) {
  setInterval(pollReplicaLag, LAG_POLL_MS).unref();
  pollReplicaLag();
}

// ── Public API ────────────────────────────────────────────────────────────────
export { db, dbRead };

/**
 * Returns the correct DB client for a read query.
 * Priority:
 *   1. forcePrimary=true  → primary (sticky-primary window after a write, or ?fresh=1)
 *   2. Replica unhealthy  → primary (auto fallback when lag > threshold)
 *   3. Replica disabled   → primary
 *   4. Otherwise          → replica
 */
export function getReadDb(opts?: { forcePrimary?: boolean }): typeof db {
  if (!REPLICA_ENABLED)    return db;
  if (opts?.forcePrimary)  return db;
  if (!replicaHealthy)     return db;
  return dbRead as typeof db;
}

export function getReplicaStats() {
  return {
    enabled:        REPLICA_ENABLED,
    healthy:        replicaHealthy,
    lagSec:         lastLagSec,
    thresholdSec:   LAG_THRESHOLD_S,
    stickyWindowMs: STICKY_MS,
  };
}
