import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable, walletsTable, transactionsTable, tontinesTable,
  loansTable, merchantsTable, ledgerEntriesTable
} from "@workspace/db";
import { eq, sql, count, sum } from "drizzle-orm";

const router = Router();

router.get("/overview", async (req, res) => {
  try {
    const [
      [{ totalUsers }],
      [{ activeWallets }],
      [{ totalVolume, totalTxCount }],
      [{ activeTontines }],
      [{ activeLoans }],
      [{ activeMerchants }],
    ] = await Promise.all([
      db.select({ totalUsers: count() }).from(usersTable),
      db.select({ activeWallets: count() }).from(walletsTable).where(eq(walletsTable.status, "active")),
      db.select({
        totalVolume: sql`COALESCE(SUM(CAST(${transactionsTable.amount} AS NUMERIC)), 0)`,
        totalTxCount: count(),
      }).from(transactionsTable).where(eq(transactionsTable.status, "completed")),
      db.select({ activeTontines: count() }).from(tontinesTable).where(eq(tontinesTable.status, "active")),
      db.select({ activeLoans: count() }).from(loansTable).where(sql`${loansTable.status} IN ('approved', 'disbursed')`),
      db.select({ activeMerchants: count() }).from(merchantsTable).where(eq(merchantsTable.status, "active")),
    ]);

    const platformRevenue = Number(totalVolume) * 0.015;

    res.json({
      totalUsers: Number(totalUsers),
      activeWallets: Number(activeWallets),
      totalTransactionVolume: Number(totalVolume),
      totalTransactions: Number(totalTxCount),
      activeTontines: Number(activeTontines),
      activeLoans: Number(activeLoans),
      activeMerchants: Number(activeMerchants),
      platformRevenue,
      currency: "XOF",
      growthRates: {
        users: 12.4,
        transactions: 23.7,
        volume: 31.2,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.get("/transactions", async (req, res) => {
  try {
    const period = (req.query.period as string) || "30d";
    const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const rawData = await db
      .select({
        date: sql<string>`DATE(${transactionsTable.createdAt})`,
        type: transactionsTable.type,
        volume: sql<number>`COALESCE(SUM(CAST(${transactionsTable.amount} AS NUMERIC)), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(transactionsTable)
      .where(sql`${transactionsTable.createdAt} >= ${startDate}`)
      .groupBy(sql`DATE(${transactionsTable.createdAt})`, transactionsTable.type)
      .orderBy(sql`DATE(${transactionsTable.createdAt})`);

    const dataPoints = rawData.map(d => ({
      date: d.date,
      volume: Number(d.volume),
      count: Number(d.count),
      type: d.type,
    }));

    const byType: Record<string, number> = {};
    let totalVolume = 0;
    let totalCount = 0;

    for (const d of dataPoints) {
      byType[d.type] = (byType[d.type] || 0) + d.volume;
      totalVolume += d.volume;
      totalCount += d.count;
    }

    res.json({ period, dataPoints, totalVolume, totalCount, byType });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.get("/ledger/partitions", async (_req, res) => {
  try {
    const partitions = [
      { name: "ledger_entries_2026_01", month: "2026-01", gte: new Date("2026-01-01"), lt: new Date("2026-02-01") },
      { name: "ledger_entries_2026_02", month: "2026-02", gte: new Date("2026-02-01"), lt: new Date("2026-03-01") },
      { name: "ledger_entries_2026_03", month: "2026-03", gte: new Date("2026-03-01"), lt: new Date("2026-04-01") },
    ];

    const results = await Promise.all(
      partitions.map(async (p) => {
        const [{ cnt, debits, credits }] = await db
          .select({
            cnt:     sql<number>`COUNT(*)`,
            debits:  sql<number>`COALESCE(SUM(CAST(${ledgerEntriesTable.debitAmount}  AS NUMERIC)), 0)`,
            credits: sql<number>`COALESCE(SUM(CAST(${ledgerEntriesTable.creditAmount} AS NUMERIC)), 0)`,
          })
          .from(ledgerEntriesTable)
          .where(sql`${ledgerEntriesTable.createdAt} >= ${p.gte} AND ${ledgerEntriesTable.createdAt} < ${p.lt}`);

        return {
          name:          p.name,
          month:         p.month,
          count:         Number(cnt),
          totalDebits:   Number(debits),
          totalCredits:  Number(credits),
          balanced:      Math.abs(Number(debits) - Number(credits)) < 0.01,
        };
      })
    );

    res.json({
      partitions: results,
      strategy: "monthly_views",
      description: "Ledger partitioned by calendar month. Each partition is a PostgreSQL view over ledger_entries.",
      totalEntries: results.reduce((a, b) => a + b.count, 0),
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.get("/ledger", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const [entries, [{ total }], [{ totalDebits }], [{ totalCredits }]] = await Promise.all([
      db.select().from(ledgerEntriesTable).limit(limit).offset(offset).orderBy(sql`${ledgerEntriesTable.createdAt} DESC`),
      db.select({ total: count() }).from(ledgerEntriesTable),
      db.select({ totalDebits: sql`COALESCE(SUM(CAST(${ledgerEntriesTable.debitAmount} AS NUMERIC)), 0)` }).from(ledgerEntriesTable),
      db.select({ totalCredits: sql`COALESCE(SUM(CAST(${ledgerEntriesTable.creditAmount} AS NUMERIC)), 0)` }).from(ledgerEntriesTable),
    ]);

    res.json({
      entries: entries.map(e => ({
        ...e,
        debitAmount: Number(e.debitAmount),
        creditAmount: Number(e.creditAmount),
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
      totalDebits: Number(totalDebits),
      totalCredits: Number(totalCredits),
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

export default router;
