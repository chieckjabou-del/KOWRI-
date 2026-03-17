// ── Metrics Collector ─────────────────────────────────────────────────────────
//
// Gathers the five system health metrics that drive the autopilot rules engine.
// All I/O is async.  The function is designed to be called every 5 s and must
// complete in < 1 s under normal conditions.
//
// Metric definitions:
//   balance_drift   abs(SUM(credit_amount) - SUM(debit_amount)) from ledger_entries
//                   Any non-zero value means the ledger is imbalanced.
//   replica_lag     Seconds behind primary; 0 when no replica is configured.
//   db_latency      Round-trip time for a SELECT 1 probe (ms).
//   outbox_pending  Events in "pending" state waiting to be dispatched.
//   dlq_rate        Events in "dead" state — exhausted all retries.

import { db }                from "@workspace/db";
import { sql }               from "drizzle-orm";
import { getReplicaLagState } from "./dbRouter";
import { getOutboxStats }    from "./outboxWorker";

export interface CollectedMetrics {
  balance_drift:  number;   // ledger imbalance (should be 0.00)
  replica_lag:    number;   // seconds behind primary (0 = no replica / up-to-date)
  db_latency:     number;   // ms for SELECT 1 round-trip
  outbox_pending: number;   // pending outbox events
  dlq_rate:       number;   // dead-letter (exhausted retries) count
  collectedAt:    Date;
}

export async function collectMetrics(): Promise<CollectedMetrics> {
  // Probe DB latency first — if this fails the whole cycle aborts (intended).
  const t0 = Date.now();
  await db.execute(sql`SELECT 1`);
  const db_latency = Date.now() - t0;

  // Ledger balance + outbox stats run in parallel.
  const [ledgerResult, outboxStats] = await Promise.all([
    db.execute<{ credits: string; debits: string }>(sql`
      SELECT
        COALESCE(SUM(CAST(credit_amount  AS NUMERIC)), 0) AS credits,
        COALESCE(SUM(CAST(debit_amount   AS NUMERIC)), 0) AS debits
      FROM ledger_entries
    `),
    getOutboxStats(),
  ]);

  const row    = (ledgerResult as any).rows?.[0];
  const credits = Number(row?.credits ?? 0);
  const debits  = Number(row?.debits  ?? 0);
  const balance_drift = Math.abs(credits - debits);

  // Replica lag is maintained by dbRouter's background poller — no extra query.
  const lagState    = getReplicaLagState();
  const replica_lag = lagState.lagSec < 0 ? 0 : lagState.lagSec;  // -1 = no replica

  return {
    balance_drift,
    replica_lag,
    db_latency,
    outbox_pending: outboxStats.pending,
    dlq_rate:       outboxStats.dead,
    collectedAt:    new Date(),
  };
}
