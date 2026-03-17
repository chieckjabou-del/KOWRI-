import { db } from "@workspace/db";
import { outboxEventsTable, processedEventsTable } from "@workspace/db";
import { eq, lte, and, sql, lt } from "drizzle-orm";
import { generateId } from "./id";
import { EventEmitter } from "events";

const BATCH_SIZE   = 50;
const POLL_MS      = 5_000;
const MAX_ATTEMPTS = 5;
const BASE_DELAY_S = 10;
const PRUNE_AFTER_DAYS = 7;

export const outboxInternalBus = new EventEmitter();
outboxInternalBus.setMaxListeners(200);

// ── Core: idempotent single-event processor ───────────────────────────────────
//
// All DB mutations run inside one transaction:
//   1. INSERT INTO processed_events ON CONFLICT DO NOTHING → RETURNING id
//   2a. No row returned  → already processed by a prior attempt
//        → mark outbox "delivered", skip emit
//   2b. Row returned     → first time we're processing this event
//        → emit to in-process subscribers
//        → mark outbox "delivered"
//        → COMMIT (processed_events row persists as the fence)
//
// Retry safety:
//   • If emit succeeds but the outbox UPDATE fails and tx rolls back
//     → processed_events row is also rolled back
//     → next retry re-emits (acceptable for idempotent handlers)
//   • If tx commits but worker crashes before the next poll
//     → processed_events row exists → next poll skips emit → marks delivered
//   • Two workers race on the same row (SKIP LOCKED prevents this, but belt+suspenders)
//     → one commits the processed_events row; the other gets DO NOTHING → skips

async function processOne(row: typeof outboxEventsTable.$inferSelect): Promise<void> {
  await db.transaction(async (tx) => {
    // ── Idempotency fence ─────────────────────────────────────────────────────
    const fence = await tx.execute<{ id: string }>(sql`
      INSERT INTO processed_events (id, outbox_event_id, topic, processed_at)
      VALUES (${generateId()}, ${row.id}, ${row.topic}, now())
      ON CONFLICT (outbox_event_id) DO NOTHING
      RETURNING id
    `);

    const alreadyProcessed = fence.rows.length === 0;

    if (!alreadyProcessed) {
      // ── Emit to in-process subscribers (non-transactional, fast) ─────────────
      const event = { type: row.topic, payload: row.payload as Record<string, unknown>, timestamp: new Date() };
      outboxInternalBus.emit(row.topic, event);
      outboxInternalBus.emit("*",       event);
    }

    // ── Mark delivered regardless (idempotent on both branches) ──────────────
    await tx.update(outboxEventsTable)
      .set({ status: "delivered" })
      .where(eq(outboxEventsTable.id, row.id));
  });
}

// ── Batch processor ───────────────────────────────────────────────────────────
async function processBatch(): Promise<void> {
  const now = new Date();

  const rows = await db
    .select()
    .from(outboxEventsTable)
    .where(and(eq(outboxEventsTable.status, "pending"), lte(outboxEventsTable.processAt, now)))
    .limit(BATCH_SIZE)
    .for("update", { skipLocked: true });

  if (rows.length === 0) return;

  // Mark all as "processing" before attempting (prevents other workers picking them up)
  await db
    .update(outboxEventsTable)
    .set({ status: "processing" })
    .where(sql`id = ANY(ARRAY[${sql.join(rows.map(r => sql`${r.id}`), sql`, `)}]::text[])`);

  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        await processOne(row);
      } catch (err: any) {
        const attempts  = (row.attempts ?? 0) + 1;
        const delaySec  = Math.pow(2, attempts) * BASE_DELAY_S;
        const processAt = new Date(Date.now() + delaySec * 1_000);

        if (attempts >= MAX_ATTEMPTS) {
          await db.update(outboxEventsTable)
            .set({ status: "dead", attempts, lastError: String(err?.message ?? err) })
            .where(eq(outboxEventsTable.id, row.id));
          console.error(`[OutboxWorker] dead-letter: topic=${row.topic} id=${row.id}`);
        } else {
          await db.update(outboxEventsTable)
            .set({ status: "pending", attempts, lastError: String(err?.message ?? err), processAt })
            .where(eq(outboxEventsTable.id, row.id));
        }
      }
    }),
  );
}

// ── Nightly prune: keep processed_events table bounded ───────────────────────
async function pruneProcessedEvents(): Promise<void> {
  const cutoff = new Date(Date.now() - PRUNE_AFTER_DAYS * 86_400_000);
  await db.delete(processedEventsTable)
    .where(lt(processedEventsTable.processedAt, cutoff));
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────
let workerInterval: ReturnType<typeof setInterval> | null = null;
let pruneInterval:  ReturnType<typeof setInterval> | null = null;

export function startOutboxWorker(): void {
  if (workerInterval) return;

  workerInterval = setInterval(async () => {
    try { await processBatch(); } catch (err) {
      console.error("[OutboxWorker] poll error:", err);
    }
  }, POLL_MS);
  workerInterval.unref();

  pruneInterval = setInterval(async () => {
    try { await pruneProcessedEvents(); } catch (err) {
      console.error("[OutboxWorker] prune error:", err);
    }
  }, 24 * 60 * 60 * 1_000);
  pruneInterval.unref();

  console.log("[OutboxWorker] started — poll every", POLL_MS / 1_000, "s | idempotency fence: processed_events");
}

export function stopOutboxWorker(): void {
  if (workerInterval) { clearInterval(workerInterval); workerInterval = null; }
  if (pruneInterval)  { clearInterval(pruneInterval);  pruneInterval  = null; }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export async function getOutboxStats() {
  const [outbox, [{ fenceTotal }]] = await Promise.all([
    db.execute<{ status: string; cnt: string }>(
      sql`SELECT status, COUNT(*)::text AS cnt FROM outbox_events GROUP BY status`,
    ),
    db.select({ fenceTotal: sql<number>`COUNT(*)::int` }).from(processedEventsTable),
  ]);

  const stats: Record<string, number> = {};
  for (const r of outbox.rows) stats[r.status] = Number(r.cnt);

  return {
    pending:       stats["pending"]    ?? 0,
    processing:    stats["processing"] ?? 0,
    delivered:     stats["delivered"]  ?? 0,
    dead:          stats["dead"]       ?? 0,
    fenceEntries:  Number(fenceTotal),
  };
}

export async function insertOutboxEvent(
  tx: typeof db,
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(outboxEventsTable).values({
    id:        generateId(),
    topic,
    payload:   payload as any,
    status:    "pending",
    attempts:  0,
    processAt: new Date(),
  });
}
