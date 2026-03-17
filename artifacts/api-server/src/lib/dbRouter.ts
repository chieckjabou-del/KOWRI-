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
let replicaHealthy  = true;
let lastLagSec      = 0;
let lastLagNullSeen = false;   // true when pg_last_xact_replay_timestamp() returned NULL

async function pollReplicaLag(): Promise<void> {
  if (!REPLICA_ENABLED) return;
  try {
    // Return lag_sec as NULL explicitly when the replay timestamp is NULL
    // (primary server, or replica that has never replayed a transaction).
    // Casting NULL to numeric still produces NULL — we detect it in application code.
    const result = await (dbRead as any).execute<{ lag_sec: string | null; has_replay: boolean }>(
      sql`SELECT
            CASE WHEN pg_last_xact_replay_timestamp() IS NULL
                 THEN NULL
                 ELSE EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::numeric
            END  AS lag_sec,
            pg_last_xact_replay_timestamp() IS NOT NULL AS has_replay`,
    );

    const row      = result.rows?.[0];
    const rawLag   = row?.lag_sec;
    const hasReplay = row?.has_replay === true || row?.has_replay === "true";

    // NULL lag means either: pointed at primary, or replica never replayed → unhealthy
    if (rawLag === null || rawLag === undefined || !hasReplay) {
      lastLagSec      = -1;          // sentinel: unknown / not a replica
      lastLagNullSeen = true;
      replicaHealthy  = false;
      console.warn("[DbRouter] pg_last_xact_replay_timestamp() is NULL — replica not streaming or URL points to primary");
      return;
    }

    const lag      = Number(rawLag);
    lastLagSec     = lag;
    lastLagNullSeen = false;
    replicaHealthy = lag <= LAG_THRESHOLD_S;
    if (!replicaHealthy) {
      console.warn(`[DbRouter] Replica lag ${lag.toFixed(1)}s > threshold ${LAG_THRESHOLD_S}s — routing reads to primary`);
    }
  } catch (err) {
    replicaHealthy  = false;
    lastLagNullSeen = false;
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

/** Consumed by windowAdvisor to feed the dynamic window calculation. */
export function getReplicaLagState() {
  return {
    healthy:      replicaHealthy,
    lagSec:       lastLagSec,
    lagNull:      lastLagNullSeen,
    thresholdSec: LAG_THRESHOLD_S,
  };
}

export function getReplicaStats() {
  return {
    enabled:        REPLICA_ENABLED,
    healthy:        replicaHealthy,
    lagSec:         lastLagSec,
    lagNull:        lastLagNullSeen,
    thresholdSec:   LAG_THRESHOLD_S,
    stickyWindowMs: STICKY_MS,
  };
}
