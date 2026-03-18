// ── Metrics Collector ─────────────────────────────────────────────────────────
//
// Gathers the five system health metrics that drive the autopilot rules engine.
// All I/O is async.  The function is designed to be called every 5 s and must
// complete in < 1 s under normal conditions.
//
// Metric definitions:
//   balance_drift   abs(total_credit - total_debit) from ledger_balance_summary
//                   Single-row O(1) read; maintained by trigger on ledger_entries.
//                   Fallback: 0 (assume balanced) when the summary row is absent.
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

  // O(1) summary read + outbox stats run in parallel.
  const [summaryResult, outboxStats] = await Promise.all([
    db.execute<{ total_credit: string; total_debit: string }>(sql`
      SELECT total_credit, total_debit
      FROM   ledger_balance_summary
      WHERE  id = 1
      LIMIT  1
    `),
    getOutboxStats(),
  ]);

  const row           = (summaryResult as any).rows?.[0];
  const totalCredit   = Number(row?.total_credit ?? 0);
  const totalDebit    = Number(row?.total_debit  ?? 0);
  const balance_drift = Math.abs(totalCredit - totalDebit);

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
