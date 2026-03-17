// ── Metrics Store ─────────────────────────────────────────────────────────────
// Thin wrapper around the metrics table.
// Inserts are fire-and-forget — callers should never await unless they need
// confirmation (e.g. tests).  Failures are logged and swallowed.

import { db } from "@workspace/db";
import { metricsTable } from "@workspace/db";
import { generateId } from "./id";

/**
 * Persist a single metric snapshot.
 *
 * @param key   Dotted metric name, e.g. "outbox.pending", "db.latencyMs"
 * @param value Numeric value at this point in time
 */
export async function insertMetric(key: string, value: number): Promise<void> {
  await db.insert(metricsTable).values({
    id:        generateId(),
    key,
    value:     String(value),
    timestamp: new Date(),
  });
}

/**
 * Convenience: write multiple metrics in one call (parallel inserts).
 */
export async function insertMetrics(entries: { key: string; value: number }[]): Promise<void> {
  if (entries.length === 0) return;
  await db.insert(metricsTable).values(
    entries.map(e => ({
      id:        generateId(),
      key:       e.key,
      value:     String(e.value),
      timestamp: new Date(),
    })),
  );
}
