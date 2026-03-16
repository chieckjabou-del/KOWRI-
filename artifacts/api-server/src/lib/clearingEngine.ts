import { db } from "@workspace/db";
import { clearingBatchesTable, clearingEntriesTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import { generateId } from "./id";
import { eventBus } from "./eventBus";
import { messageQueue, MESSAGE_TOPICS } from "./messageQueue";

export interface ClearingEntry {
  fromAccountId: string;
  toAccountId:   string;
  amount:        number;
  currency?:     string;
  externalRef?:  string;
  metadata?:     Record<string, unknown>;
}

export async function createClearingBatch(
  institutionId: string,
  currency = "XOF",
  metadata?: Record<string, unknown>
): Promise<{ id: string; batchRef: string }> {
  const id       = generateId("clrb");
  const batchRef = `CLR-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await db.insert(clearingBatchesTable).values({
    id, batchRef, institutionId, currency,
    status: "pending", totalAmount: "0", entryCount: 0,
    metadata: metadata ?? {},
  });
  return { id, batchRef };
}

export async function addClearingEntry(
  batchId: string,
  entry: ClearingEntry
): Promise<string> {
  const id = generateId("clre");
  await db.insert(clearingEntriesTable).values({
    id, batchId,
    fromAccountId: entry.fromAccountId,
    toAccountId:   entry.toAccountId,
    amount:        String(entry.amount),
    currency:      entry.currency ?? "XOF",
    externalRef:   entry.externalRef,
    metadata:      entry.metadata ?? {},
    status:        "pending",
  });
  await db
    .update(clearingBatchesTable)
    .set({
      entryCount:  sql`${clearingBatchesTable.entryCount} + 1`,
      totalAmount: sql`${clearingBatchesTable.totalAmount} + ${String(entry.amount)}`,
    })
    .where(eq(clearingBatchesTable.id, batchId));
  return id;
}

export async function submitBatch(batchId: string): Promise<void> {
  await db
    .update(clearingBatchesTable)
    .set({ status: "submitted", submittedAt: new Date() })
    .where(and(eq(clearingBatchesTable.id, batchId), eq(clearingBatchesTable.status, "pending")));
  await db
    .update(clearingEntriesTable)
    .set({ status: "submitted" })
    .where(eq(clearingEntriesTable.batchId, batchId));
  await eventBus.publish("clearing.started", { batchId });
  await messageQueue.produce(MESSAGE_TOPICS.SETTLEMENTS, { event: "clearing.started", batchId });
}

export async function settleBatch(batchId: string): Promise<void> {
  await db
    .update(clearingBatchesTable)
    .set({ status: "settled", settledAt: new Date() })
    .where(eq(clearingBatchesTable.id, batchId));
  await db
    .update(clearingEntriesTable)
    .set({ status: "settled" })
    .where(eq(clearingEntriesTable.batchId, batchId));
  await eventBus.publish("clearing.settled", { batchId });
  await messageQueue.produce(MESSAGE_TOPICS.SETTLEMENTS, { event: "clearing.settled", batchId });
}

export async function failBatch(batchId: string, reason: string): Promise<void> {
  await db
    .update(clearingBatchesTable)
    .set({ status: "failed", failedAt: new Date(), metadata: { reason } })
    .where(eq(clearingBatchesTable.id, batchId));
  await db
    .update(clearingEntriesTable)
    .set({ status: "failed" })
    .where(eq(clearingEntriesTable.batchId, batchId));
  await eventBus.publish("clearing.failed", { batchId, reason });
}

export async function getBatches(institutionId?: string) {
  const rows = institutionId
    ? await db.select().from(clearingBatchesTable).where(eq(clearingBatchesTable.institutionId, institutionId))
    : await db.select().from(clearingBatchesTable);
  return rows;
}

export async function getBatchEntries(batchId: string) {
  return db.select().from(clearingEntriesTable).where(eq(clearingEntriesTable.batchId, batchId));
}

export async function getClearingStats() {
  const rows = await db.select({
    status: clearingBatchesTable.status,
    cnt:    sql<number>`count(*)`,
    total:  sql<string>`coalesce(sum(${clearingBatchesTable.totalAmount}), 0)`,
  })
    .from(clearingBatchesTable)
    .groupBy(clearingBatchesTable.status);
  return rows.reduce<Record<string, { count: number; total: number }>>((acc, r) => {
    acc[r.status] = { count: Number(r.cnt), total: Number(r.total) };
    return acc;
  }, {});
}
