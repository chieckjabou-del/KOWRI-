// ── Incident Store ────────────────────────────────────────────────────────────
// Append-only log of auto-heal loop decisions (detect → diagnose → act → result).
// All writes are fire-and-forget.  Callers MUST NOT depend on the returned value
// for control flow — this is a best-effort audit trail only.

import { db } from "@workspace/db";
import { incidentsTable } from "@workspace/db";
import { generateId } from "./id";

export interface IncidentEntry {
  type:   string;   // what was detected,  e.g. "latency_spike" | "ledger_drift"
  action: string;   // what was taken,     e.g. "fire:outbound_transfers" | "noop"
  result: string;   // outcome,            e.g. "recovered" | "escalated" | "failed"
}

// Unix ms of the most recent successfully written incident.
// Read by /live to compute cyclesSinceLastIncident without a DB query.
let _lastIncidentAt = 0;

export function getLastIncidentTime(): number {
  return _lastIncidentAt;
}

/**
 * Log a single incident.  Returns the generated id on success, null on failure.
 */
export async function insertIncident(entry: IncidentEntry): Promise<string | null> {
  const id = generateId();
  try {
    await db.insert(incidentsTable).values({ id, ...entry, createdAt: new Date() });
    _lastIncidentAt = Date.now();
    return id;
  } catch (err) {
    console.error("[IncidentStore] insert failed:", err);
    return null;
  }
}

/**
 * Log an incident without awaiting.  Safe to call from synchronous contexts.
 */
export function logIncident(entry: IncidentEntry): void {
  insertIncident(entry).catch(() => {});
}
