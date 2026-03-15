import { db } from "@workspace/db";
import { ledgerEntriesTable, walletsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export async function getWalletBalance(walletId: string): Promise<number> {
  const [result] = await db
    .select({
      balance: sql<number>`
        COALESCE(SUM(CAST(${ledgerEntriesTable.creditAmount} AS NUMERIC)), 0) -
        COALESCE(SUM(CAST(${ledgerEntriesTable.debitAmount} AS NUMERIC)), 0)
      `,
    })
    .from(ledgerEntriesTable)
    .where(
      sql`${ledgerEntriesTable.accountId} = ${walletId} AND ${ledgerEntriesTable.accountType} = 'wallet'`
    );
  return Number(result?.balance ?? 0);
}

export async function syncWalletBalance(
  walletId: string,
  txClient?: typeof db
): Promise<number> {
  const client = txClient ?? db;
  const [result] = await client
    .select({
      balance: sql<number>`
        COALESCE(SUM(CAST(${ledgerEntriesTable.creditAmount} AS NUMERIC)), 0) -
        COALESCE(SUM(CAST(${ledgerEntriesTable.debitAmount} AS NUMERIC)), 0)
      `,
    })
    .from(ledgerEntriesTable)
    .where(
      sql`${ledgerEntriesTable.accountId} = ${walletId} AND ${ledgerEntriesTable.accountType} = 'wallet'`
    );

  const derived = Number(result?.balance ?? 0);

  await client
    .update(walletsTable)
    .set({
      balance: String(derived),
      availableBalance: String(derived),
      updatedAt: new Date(),
    })
    .where(eq(walletsTable.id, walletId));

  return derived;
}

export async function reconcileAllWallets(): Promise<
  Array<{ walletId: string; stored: number; derived: number; mismatch: boolean }>
> {
  const wallets = await db.select().from(walletsTable);
  const report = [];

  for (const w of wallets) {
    const derived = await getWalletBalance(w.id);
    const stored = Number(w.balance);
    const mismatch = Math.abs(stored - derived) > 0.01;
    report.push({ walletId: w.id, stored, derived, mismatch });
  }

  return report;
}
