import { db } from "@workspace/db";
import { transactionsTable, ledgerArchiveTable } from "@workspace/db";
import { lt, eq, sql, and, asc } from "drizzle-orm";
import { generateId } from "./id";

export interface ArchiveResult {
  archivedCount: number;
  year:          number;
  durationMs:    number;
}

export async function archiveLedger(
  beforeYear: number,
  batchSize = 500
): Promise<ArchiveResult> {
  const start   = Date.now();
  const cutoff  = new Date(`${beforeYear}-01-01T00:00:00.000Z`);
  const archiveYear = beforeYear - 1;

  const rows = await db.select()
    .from(transactionsTable)
    .where(lt(transactionsTable.createdAt, cutoff))
    .orderBy(asc(transactionsTable.createdAt))
    .limit(batchSize);

  if (rows.length === 0) {
    return { archivedCount: 0, year: archiveYear, durationMs: Date.now() - start };
  }

  const archiveRows = rows.map((tx) => ({
    id:               generateId(),
    originalTxId:     tx.id,
    walletId:         tx.toWalletId ?? tx.fromWalletId ?? "unknown",
    type:             tx.type,
    amount:           tx.amount,
    currency:         tx.currency,
    balanceAfter:     null as string | null,
    archiveYear:      Number(tx.createdAt.getFullYear()),
    archivedAt:       new Date(),
    originalCreatedAt: tx.createdAt,
  }));

  await db.insert(ledgerArchiveTable).values(archiveRows).onConflictDoNothing();

  console.log(`[Archiver] Archived ${archiveRows.length} transactions (year <= ${archiveYear})`);

  return {
    archivedCount: archiveRows.length,
    year:          archiveYear,
    durationMs:    Date.now() - start,
  };
}

export async function getArchiveStats(): Promise<Array<{ year: number; count: number }>> {
  const rows = await db.select({
    year:  ledgerArchiveTable.archiveYear,
    count: sql<number>`count(*)`,
  })
    .from(ledgerArchiveTable)
    .groupBy(ledgerArchiveTable.archiveYear)
    .orderBy(asc(ledgerArchiveTable.archiveYear));

  return rows.map((r) => ({ year: r.year, count: Number(r.count) }));
}

export async function queryArchive(walletId: string, year?: number): Promise<typeof ledgerArchiveTable.$inferSelect[]> {
  const conditions = [eq(ledgerArchiveTable.walletId, walletId)];
  if (year) {
    conditions.push(eq(ledgerArchiveTable.archiveYear, year));
  }
  return db.select()
    .from(ledgerArchiveTable)
    .where(and(...conditions))
    .orderBy(asc(ledgerArchiveTable.originalCreatedAt))
    .limit(200);
}
