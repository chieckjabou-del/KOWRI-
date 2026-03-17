import { db } from "@workspace/db";
import { outboxEventsTable } from "@workspace/db";
import { eq, lte, and, sql } from "drizzle-orm";
import { generateId } from "./id";
import { EventEmitter } from "events";

const BATCH_SIZE    = 50;
const POLL_MS       = 5_000;
const MAX_ATTEMPTS  = 5;
const BASE_DELAY_S  = 10;

export const outboxInternalBus = new EventEmitter();
outboxInternalBus.setMaxListeners(200);

async function processBatch(): Promise<void> {
  const now = new Date();

  const rows = await db
    .select()
    .from(outboxEventsTable)
    .where(and(eq(outboxEventsTable.status, "pending"), lte(outboxEventsTable.processAt, now)))
    .limit(BATCH_SIZE)
    .for("update", { skipLocked: true });

  if (rows.length === 0) return;

  await db
    .update(outboxEventsTable)
    .set({ status: "processing" })
    .where(sql`id = ANY(ARRAY[${sql.join(rows.map(r => sql`${r.id}`), sql`, `)}]::text[])`);

  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        outboxInternalBus.emit(row.topic, { type: row.topic, payload: row.payload, timestamp: new Date() });
        outboxInternalBus.emit("*",       { type: row.topic, payload: row.payload, timestamp: new Date() });

        await db.update(outboxEventsTable)
          .set({ status: "delivered" })
          .where(eq(outboxEventsTable.id, row.id));
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

let workerInterval: ReturnType<typeof setInterval> | null = null;

export function startOutboxWorker(): void {
  if (workerInterval) return;
  workerInterval = setInterval(async () => {
    try { await processBatch(); } catch (err) {
      console.error("[OutboxWorker] poll error:", err);
    }
  }, POLL_MS);
  workerInterval.unref();
  console.log("[OutboxWorker] started — poll every", POLL_MS / 1_000, "s");
}

export function stopOutboxWorker(): void {
  if (workerInterval) { clearInterval(workerInterval); workerInterval = null; }
}

export async function getOutboxStats() {
  const rows = await db.execute<{ status: string; cnt: string }>(
    sql`SELECT status, COUNT(*)::text AS cnt FROM outbox_events GROUP BY status`,
  );
  const stats: Record<string, number> = {};
  for (const r of rows.rows) stats[r.status] = Number(r.cnt);
  return {
    pending:    stats["pending"]    ?? 0,
    processing: stats["processing"] ?? 0,
    delivered:  stats["delivered"]  ?? 0,
    dead:       stats["dead"]       ?? 0,
  };
}

export async function insertOutboxEvent(
  tx: typeof db,
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(outboxEventsTable).values({
    id:       generateId(),
    topic,
    payload:  payload as any,
    status:   "pending",
    attempts: 0,
    processAt: new Date(),
  });
}
