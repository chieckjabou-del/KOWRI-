import { db } from "@workspace/db";
import { outboxEventsTable, processedEventsTable } from "@workspace/db";
import { eq, lte, and, sql, lt } from "drizzle-orm";
import { generateId } from "./id";
import { EventEmitter } from "events";

const BATCH_SIZE        = 50;
const POLL_MS           = 5_000;
const MAX_DELAY_S       = 300;      // 5-minute ceiling on any single backoff
const JITTER_FACTOR     = 0.15;     // ±15% randomised jitter
const PRUNE_AFTER_DAYS  = 7;

export const outboxInternalBus = new EventEmitter();
outboxInternalBus.setMaxListeners(200);

// ── Error classification ──────────────────────────────────────────────────────
//
// Each incoming error is mapped to one of seven classes.  The class drives
// the retry policy (maxAttempts, backoff strategy, base delay).
//
// Inputs checked (in order):
//   • err.code   — PostgreSQL SQLSTATE or Node.js errno string
//   • err.message (lowercased)
//
// Class hierarchy (most-specific first):
//   deadlock → serialization → db_conn → network → rate_limit → timeout
//   → permanent → unknown
//
//   "permanent" is the only class that sends straight to DLQ on attempt 1.

export type ErrorClass =
  | "deadlock"       // PG 40P01 — row-level deadlock
  | "serialization"  // PG 40001 — MVCC serialization failure
  | "db_conn"        // PG 08xxx / 57P01 / pool exhausted
  | "network"        // ECONNRESET / ECONNREFUSED / ENOTFOUND
  | "rate_limit"     // HTTP 429 / "too many requests"
  | "timeout"        // ETIMEDOUT / PG 57014 query_canceled
  | "permanent"      // data/logic error — will NOT self-heal
  | "unknown";       // conservative default

export function classifyError(err: unknown): ErrorClass {
  const code = (err as any)?.code as string | undefined;
  const msg  = String((err as any)?.message ?? err).toLowerCase();

  // ── PostgreSQL SQLSTATE codes ─────────────────────────────────────────────
  if (code === "40P01" || msg.includes("deadlock"))                                  return "deadlock";
  if (code === "40001" || msg.includes("could not serialize") ||
                          msg.includes("serialization failure"))                      return "serialization";

  if (["08000","08001","08003","08006","57P01"].includes(code ?? "") ||
      (msg.includes("connection") && (msg.includes("pool")      ||
                                      msg.includes("terminated") ||
                                      msg.includes("fatal"))))                        return "db_conn";

  if (code === "57014" || (msg.includes("timeout") && msg.includes("query")))        return "timeout";

  // Permanent data/constraint errors — retrying will never fix these
  if (["23000","23001","23502","23503","23505",
       "22001","22003","22007","22P02"].includes(code ?? "") ||
      msg.includes("invalid input syntax") ||
      msg.includes("violates")             ||
      msg.includes("does not exist"))                                                 return "permanent";

  // ── Node.js / network codes ───────────────────────────────────────────────
  if (["ECONNRESET","ECONNREFUSED","EHOSTUNREACH",
       "ENOTFOUND","ECONNABORTED"].includes(code ?? "") ||
      msg.includes("connection reset") ||
      msg.includes("econnreset")       ||
      msg.includes("network"))                                                        return "network";

  if (code === "ETIMEDOUT" || msg.includes("timed out") ||
      msg.includes("etimedout"))                                                      return "timeout";

  // ── HTTP-layer signals (downstream service calls) ─────────────────────────
  if (code === "429" || msg.includes("rate limit") ||
      msg.includes("too many requests"))                                              return "rate_limit";

  return "unknown";
}

// ── Per-class retry policy ────────────────────────────────────────────────────
//
//  strategy:
//    "linear"       → delay = base × attempt           (fast churn errors)
//    "exponential"  → delay = 2^(attempt-1) × base     (transient errors)
//    "dlq"          → send to dead-letter immediately   (permanent errors)
//
//  maxAttempts:
//    How many total attempts (including the first) before DLQ.
//    "permanent" uses maxAttempts=0 — the DLQ path is taken before this check.

interface RetryPolicy {
  maxAttempts: number;
  baseDelaySec: number;
  strategy: "linear" | "exponential" | "dlq";
}

const RETRY_POLICY: Record<ErrorClass, RetryPolicy> = {
  //            maxAttempts  baseDelaySec  strategy
  deadlock:     { maxAttempts: 10, baseDelaySec:  1, strategy: "linear"      },
  serialization:{ maxAttempts: 10, baseDelaySec:  1, strategy: "linear"      },
  db_conn:      { maxAttempts:  6, baseDelaySec:  5, strategy: "exponential" },
  network:      { maxAttempts:  8, baseDelaySec: 10, strategy: "exponential" },
  rate_limit:   { maxAttempts:  5, baseDelaySec: 30, strategy: "exponential" },
  timeout:      { maxAttempts:  6, baseDelaySec: 15, strategy: "exponential" },
  permanent:    { maxAttempts:  0, baseDelaySec:  0, strategy: "dlq"         },
  unknown:      { maxAttempts:  5, baseDelaySec: 10, strategy: "exponential" },
};

// ── Backoff calculator ────────────────────────────────────────────────────────
//
//  Adds ±JITTER_FACTOR randomised noise to break thundering-herd.
//  Hard-capped at MAX_DELAY_S regardless of class.
//
//  Examples (no jitter, base=10, exponential):
//    attempt 1 →  10 s
//    attempt 2 →  20 s
//    attempt 3 →  40 s
//    attempt 4 →  80 s   → cap at 300 s
//
//  Examples (no jitter, base=1, linear):
//    attempt 1 →   1 s
//    attempt 2 →   2 s
//    attempt 3 →   3 s

export function computeDelayMs(policy: RetryPolicy, attempt: number): number {
  let delaySec: number;

  switch (policy.strategy) {
    case "linear":
      delaySec = policy.baseDelaySec * attempt;
      break;
    case "exponential":
      delaySec = Math.pow(2, attempt - 1) * policy.baseDelaySec;
      break;
    case "dlq":
      return 0;
  }

  // Clamp before jitter so the ceiling is absolute
  delaySec = Math.min(delaySec, MAX_DELAY_S);

  // ±JITTER_FACTOR (uniform, not gaussian — simpler, equally effective)
  const jitter = delaySec * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.round(Math.max(0, delaySec + jitter) * 1_000);
}

// ── Dead-letter decision ──────────────────────────────────────────────────────
//
//  Dead-letter when ANY of:
//    1. errorClass === "permanent"        (logic error — will never succeed)
//    2. attempts >= policy.maxAttempts    (exhausted budget for this class)
//    3. attempts > 10                     (global backstop regardless of class)

export function shouldDeadLetter(errorClass: ErrorClass, attempts: number): boolean {
  if (errorClass === "permanent")                               return true;
  if (attempts > 10)                                            return true;
  if (attempts >= RETRY_POLICY[errorClass].maxAttempts)        return true;
  return false;
}

// ── Idempotent single-event processor ────────────────────────────────────────
//
//  All DB mutations run inside one transaction:
//    1. INSERT INTO processed_events ON CONFLICT DO NOTHING → RETURNING id
//    2a. No row returned  → already processed by a prior attempt
//         → mark outbox "delivered", skip emit
//    2b. Row returned     → first time we're processing this event
//         → emit to in-process subscribers
//         → mark outbox "delivered"
//         → COMMIT (processed_events row persists as the fence)
//
//  Retry safety:
//    • If emit succeeds but the outbox UPDATE fails → tx rolls back
//      → processed_events row is also rolled back
//      → next retry re-emits (acceptable for idempotent handlers)
//    • If tx commits but worker crashes before next poll
//      → processed_events row exists → next poll skips emit → marks delivered
//    • Two workers race (SKIP LOCKED prevents this, belt+suspenders)
//      → one commits; the other gets DO NOTHING → skips

async function processOne(row: typeof outboxEventsTable.$inferSelect): Promise<void> {
  await db.transaction(async (tx) => {
    const fence = await tx.execute<{ id: string }>(sql`
      INSERT INTO processed_events (id, outbox_event_id, topic, processed_at)
      VALUES (${generateId()}, ${row.id}, ${row.topic}, now())
      ON CONFLICT (outbox_event_id) DO NOTHING
      RETURNING id
    `);

    const alreadyProcessed = fence.rows.length === 0;

    if (!alreadyProcessed) {
      const event = { type: row.topic, payload: row.payload as Record<string, unknown>, timestamp: new Date() };
      outboxInternalBus.emit(row.topic, event);
      outboxInternalBus.emit("*",       event);
    }

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

  await db
    .update(outboxEventsTable)
    .set({ status: "processing" })
    .where(sql`id = ANY(ARRAY[${sql.join(rows.map(r => sql`${r.id}`), sql`, `)}]::text[])`);

  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        await processOne(row);
      } catch (err: unknown) {
        const errorClass = classifyError(err);
        const attempts   = (row.attempts ?? 0) + 1;
        const policy     = RETRY_POLICY[errorClass];
        const errMsg     = `[${errorClass}] ${String((err as any)?.message ?? err)}`;

        if (shouldDeadLetter(errorClass, attempts)) {
          await db.update(outboxEventsTable)
            .set({ status: "dead", attempts, lastError: errMsg })
            .where(eq(outboxEventsTable.id, row.id));
          console.error(`[OutboxWorker] dead-letter: topic=${row.topic} id=${row.id} class=${errorClass} attempts=${attempts}`);
        } else {
          const delayMs   = computeDelayMs(policy, attempts);
          const processAt = new Date(Date.now() + delayMs);
          await db.update(outboxEventsTable)
            .set({ status: "pending", attempts, lastError: errMsg, processAt })
            .where(eq(outboxEventsTable.id, row.id));
          console.warn(`[OutboxWorker] retry: topic=${row.topic} id=${row.id} class=${errorClass} attempt=${attempts}/${policy.maxAttempts} delay=${Math.round(delayMs/1000)}s`);
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
//
//  dead.byClass is derived by parsing the "[class] message" prefix written
//  into lastError — no schema change required.

export async function getOutboxStats() {
  const [outbox, [{ fenceTotal }], deadRows] = await Promise.all([
    db.execute<{ status: string; cnt: string }>(
      sql`SELECT status, COUNT(*)::text AS cnt FROM outbox_events GROUP BY status`,
    ),
    db.select({ fenceTotal: sql<number>`COUNT(*)::int` }).from(processedEventsTable),
    db.execute<{ last_error: string | null }>(
      sql`SELECT last_error FROM outbox_events WHERE status = 'dead'`,
    ),
  ]);

  const stats: Record<string, number> = {};
  for (const r of outbox.rows) stats[r.status] = Number(r.cnt);

  // Tally dead events by error class
  const deadByClass: Record<string, number> = {};
  for (const r of deadRows.rows) {
    const match = r.last_error?.match(/^\[([a-z_]+)\]/);
    const cls   = match?.[1] ?? "unknown";
    deadByClass[cls] = (deadByClass[cls] ?? 0) + 1;
  }

  return {
    pending:      stats["pending"]    ?? 0,
    processing:   stats["processing"] ?? 0,
    delivered:    stats["delivered"]  ?? 0,
    dead:         stats["dead"]       ?? 0,
    deadByClass,
    fenceEntries: Number(fenceTotal),
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
