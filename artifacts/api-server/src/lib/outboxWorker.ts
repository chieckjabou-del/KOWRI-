import { db } from "@workspace/db";
import { outboxEventsTable, processedEventsTable } from "@workspace/db";
import { eq, lte, and, sql, lt, asc } from "drizzle-orm";
import { generateId } from "./id";
import { EventEmitter } from "events";

const BATCH_SIZE        = 50;
const POLL_MS           = 5_000;
const MAX_DELAY_S       = 300;      // 5-minute ceiling on any single backoff
const JITTER_FACTOR     = 0.15;     // ±15% randomised jitter
const PRUNE_AFTER_DAYS  = 7;

// ── Analytics deferral ────────────────────────────────────────────────────────
// When the last batch took > DEFER_LATENCY_MS to execute, analytics events
// (priority = 9) are excluded from the next sweep so payment and fraud events
// drain without competing for DB write capacity.
// Resets automatically the moment batch duration drops back below the threshold.
// ROLLBACK: remove this block and the two references in processBatch below.
const DEFER_LATENCY_MS  = 150;
let   deferAnalytics    = false;    // toggled by processBatch; read at sweep start

export function getAnalyticsDeferralState() {
  return { deferAnalytics, thresholdMs: DEFER_LATENCY_MS };
}

// ── Priority levels ───────────────────────────────────────────────────────────
// Lower number = processed first.  Column default = MEDIUM (5).
// All existing rows with no priority column value inherit MEDIUM via DB default.
export const PRIORITY = {
  CRITICAL:  1,   // payments, fraud, compliance — must not wait behind any other event
  HIGH:      3,   // wallet ops, ledger writes, tontine payouts
  MEDIUM:    5,   // default — general business events
  LOW:       7,   // notifications, webhooks
  ANALYTICS: 9,   // analytics, reporting — acceptable to lag behind everything else
} as const;

// ── Topic → priority auto-mapper ──────────────────────────────────────────────
// Called by insertOutboxEvent when caller does not supply an explicit priority.
// Falls back to MEDIUM for unrecognised prefixes.
export function topicPriority(topic: string): number {
  if (/^(payment|fraud|compliance|aml)\./.test(topic))            return PRIORITY.CRITICAL;
  if (/^(wallet|ledger|tontine|insurance|transfer)\./.test(topic)) return PRIORITY.HIGH;
  if (/^(analytics|report|metric)\./.test(topic))                  return PRIORITY.ANALYTICS;
  if (/^(notification|webhook|email|sms)\./.test(topic))           return PRIORITY.LOW;
  return PRIORITY.MEDIUM;
}

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

  // Permanent data/constraint errors — retrying will never fix these.
  // "does not exist" is intentionally scoped to schema-level objects (column /
  // relation / function) and must NOT match application-level "user does not
  // exist" messages, which are recoverable once the resource is created.
  if (["23000","23001","23502","23503","23505",
       "22001","22003","22007","22P02"].includes(code ?? "") ||
      msg.includes("invalid input syntax") ||
      msg.includes("violates")             ||
      (msg.includes("does not exist") &&
       (msg.includes("column") || msg.includes("relation") ||
        msg.includes("function") || msg.includes("table"))))                         return "permanent";

  // ── Node.js / network codes ───────────────────────────────────────────────
  if (["ECONNRESET","ECONNREFUSED","EHOSTUNREACH",
       "ENOTFOUND","ECONNABORTED"].includes(code ?? "") ||
      msg.includes("connection reset") ||
      msg.includes("econnreset")       ||
      msg.includes("network"))                                                        return "network";

  // ETIMEDOUT must come after the other network codes — it is a timeout, not
  // a connectivity failure, and gets a different retry policy (longer base delay).
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
  const now       = new Date();
  const batchStart = Date.now();
  const skipAnalytics = deferAnalytics;   // snapshot flag before any await

  // SELECT and UPDATE must be in the same transaction so the FOR UPDATE SKIP
  // LOCKED row locks are held until the status flip commits.  Outside a tx the
  // lock releases immediately after the SELECT, leaving a window where a second
  // worker instance could pick the same rows.
  const rows = await db.transaction(async (tx) => {
    const baseWhere = and(
      eq(outboxEventsTable.status, "pending"),
      lte(outboxEventsTable.processAt, now),
      // ANALYTICS DEFERRAL: exclude priority=9 events when last batch was slow
      skipAnalytics ? lt(outboxEventsTable.priority, PRIORITY.ANALYTICS) : undefined,
    );

    const selected = await tx
      .select()
      .from(outboxEventsTable)
      .where(baseWhere)
      .orderBy(asc(outboxEventsTable.priority), asc(outboxEventsTable.processAt))
      .limit(BATCH_SIZE)
      .for("update", { skipLocked: true });

    if (selected.length === 0) return [];

    await tx
      .update(outboxEventsTable)
      .set({ status: "processing" })
      .where(sql`id = ANY(ARRAY[${sql.join(selected.map(r => sql`${r.id}`), sql`, `)}]::text[])`);

    return selected;
  });

  if (rows.length === 0) return;

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
          const retries   = (row.retries ?? 0) + 1;   // attempts = total tries; retries = reschedule count
          await db.update(outboxEventsTable)
            .set({ status: "pending", attempts, retries, lastError: errMsg, processAt })
            .where(eq(outboxEventsTable.id, row.id));
          console.warn(`[OutboxWorker] retry: topic=${row.topic} id=${row.id} class=${errorClass} attempt=${attempts}/${policy.maxAttempts} retries=${retries} delay=${Math.round(delayMs/1000)}s`);
        }
      }
    }),
  );

  // ANALYTICS DEFERRAL: update flag based on this batch's wall-clock duration.
  // Next sweep reads the updated flag before issuing its SELECT.
  const batchMs    = Date.now() - batchStart;
  const wasDeferred = deferAnalytics;
  deferAnalytics    = batchMs > DEFER_LATENCY_MS;
  if (deferAnalytics !== wasDeferred) {
    console.info(`[OutboxWorker] analytics deferral ${deferAnalytics ? "ON" : "OFF"} — batchMs=${batchMs}`);
  }
}

// ── Startup recovery: reset stuck "processing" rows ──────────────────────────
// If the process crashed after marking rows "processing" but before completing
// them, they are permanently invisible to processBatch (which only selects
// "pending").  On every startup, reset those rows to "pending" so they're
// retried.  This is safe because processOne is idempotent via the
// processed_events fence: even if a row completed before the crash, the fence
// prevents a duplicate emit on re-processing.

// ── One-time index: ensure priority-aware batch SELECT is efficient ───────────
// A partial index on pending rows avoids a full-table scan on every poll cycle.
// CREATE INDEX IF NOT EXISTS is idempotent — safe to run on every startup.

async function ensureOutboxIndex(): Promise<void> {
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS outbox_priority_pending_idx
      ON outbox_events (priority ASC, process_at ASC)
      WHERE status = 'pending'
  `);
}

async function recoverStuckProcessing(): Promise<void> {
  const result = await db.execute<{ count: string }>(sql`
    UPDATE outbox_events
    SET status = 'pending', process_at = now()
    WHERE status = 'processing'
    RETURNING id
  `);
  const n = result.rows?.length ?? 0;
  if (n > 0) console.warn(`[OutboxWorker] recovered ${n} stuck-processing rows`);
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

  // Both tasks are fire-and-forget before the first poll cycle.
  ensureOutboxIndex().catch((err) =>
    console.error("[OutboxWorker] index creation failed:", err),
  );
  recoverStuckProcessing().catch((err) =>
    console.error("[OutboxWorker] startup recovery failed:", err),
  );

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
  // deadByClass: group dead events by the "[class]" prefix in last_error
  // entirely in SQL — avoids fetching every last_error string into Node.js.
  const [outbox, [{ fenceTotal }], deadClassRows] = await Promise.all([
    db.execute<{ status: string; cnt: string }>(
      sql`SELECT status, COUNT(*)::text AS cnt FROM outbox_events GROUP BY status`,
    ),
    db.select({ fenceTotal: sql<number>`COUNT(*)::int` }).from(processedEventsTable),
    db.execute<{ cls: string | null; cnt: string }>(sql`
      SELECT
        COALESCE(substring(last_error FROM '^\[([a-z_]+)\]'), 'unknown') AS cls,
        COUNT(*)::text AS cnt
      FROM outbox_events
      WHERE status = 'dead'
      GROUP BY cls
    `),
  ]);

  const stats: Record<string, number> = {};
  for (const r of outbox.rows) stats[r.status] = Number(r.cnt);

  const deadByClass: Record<string, number> = {};
  for (const r of deadClassRows.rows) {
    deadByClass[r.cls ?? "unknown"] = Number(r.cnt);
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
  priority?: number,
): Promise<void> {
  // Clamp to the valid range so a caller cannot accidentally jump ahead of
  // CRITICAL (1) or lag behind ANALYTICS (9) without an explicit PRIORITY value.
  const resolvedPriority = Math.min(
    PRIORITY.ANALYTICS,
    Math.max(PRIORITY.CRITICAL, priority ?? topicPriority(topic)),
  );

  await tx.insert(outboxEventsTable).values({
    id:        generateId(),
    topic,
    payload:   payload as any,
    status:    "pending",
    attempts:  0,
    priority:  resolvedPriority,
    processAt: new Date(),
  });
}
