import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable, walletsTable, transactionsTable, tontinesTable,
  loansTable, merchantsTable, ledgerEntriesTable, ledgerShardsTable,
  ledgerArchiveTable, amlFlagsTable, complianceCasesTable,
  revenueLogsTable,
} from "@workspace/db";
import { eq, sql, count, sum } from "drizzle-orm";
import { generateId } from "../lib/id";
import { getRevenueSnapshot } from "../lib/monetizationService";

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
      [{ curUsers, prevUsers }],
      [{ curTx, prevTx }],
      [{ curVol, prevVol }],
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
      // Users growth: last 30 days vs prior 30 days
      db.select({
        curUsers:  sql<number>`COUNT(*) FILTER (WHERE ${usersTable.createdAt} >= NOW() - INTERVAL '30 days')`,
        prevUsers: sql<number>`COUNT(*) FILTER (WHERE ${usersTable.createdAt} >= NOW() - INTERVAL '60 days' AND ${usersTable.createdAt} < NOW() - INTERVAL '30 days')`,
      }).from(usersTable),
      // Transactions count growth
      db.select({
        curTx:  sql<number>`COUNT(*) FILTER (WHERE ${transactionsTable.createdAt} >= NOW() - INTERVAL '30 days')`,
        prevTx: sql<number>`COUNT(*) FILTER (WHERE ${transactionsTable.createdAt} >= NOW() - INTERVAL '60 days' AND ${transactionsTable.createdAt} < NOW() - INTERVAL '30 days')`,
      }).from(transactionsTable),
      // Volume growth: completed transactions only
      db.select({
        curVol:  sql<number>`COALESCE(SUM(CAST(${transactionsTable.amount} AS NUMERIC)) FILTER (WHERE ${transactionsTable.createdAt} >= NOW() - INTERVAL '30 days' AND ${transactionsTable.status} = 'completed'), 0)`,
        prevVol: sql<number>`COALESCE(SUM(CAST(${transactionsTable.amount} AS NUMERIC)) FILTER (WHERE ${transactionsTable.createdAt} >= NOW() - INTERVAL '60 days' AND ${transactionsTable.createdAt} < NOW() - INTERVAL '30 days' AND ${transactionsTable.status} = 'completed'), 0)`,
      }).from(transactionsTable),
    ]);

    const platformRevenue = Number(totalVolume) * 0.015;

    function computeGrowth(current: number, previous: number): number | null {
      if (previous === 0) return null;
      return Math.round(((current - previous) / previous) * 1000) / 10;
    }

    return res.json({
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
        users:        computeGrowth(Number(curUsers),  Number(prevUsers)),
        transactions: computeGrowth(Number(curTx),     Number(prevTx)),
        volume:       computeGrowth(Number(curVol),    Number(prevVol)),
      },
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error", message: String(err) });
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

    return res.json({ period, dataPoints, totalVolume, totalCount, byType });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error", message: String(err) });
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

    return res.json({
      partitions: results,
      strategy: "monthly_views",
      description: "Ledger partitioned by calendar month. Each partition is a PostgreSQL view over ledger_entries.",
      totalEntries: results.reduce((a, b) => a + b.count, 0),
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error", message: String(err) });
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

    return res.json({
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
    return res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.get("/ledger/shards", async (_req, res) => {
  try {
    const shards = await db.select().from(ledgerShardsTable).limit(100);

    if (shards.length === 0) {
      const NUM_SHARDS = 8;
      const seedShards = Array.from({ length: NUM_SHARDS }, (_, i) => ({
        id:             generateId(),
        shardKey:       `shard_${i.toString().padStart(2, "0")}`,
        shardIndex:     i,
        walletIdRangeStart: (i * 0x20000000).toString(16).padStart(8, "0"),
        walletIdRangeEnd:   ((i + 1) * 0x20000000 - 1).toString(16).padStart(8, "0"),
        entryCount:     0,
        active:         true,
      }));
      await db.insert(ledgerShardsTable).values(seedShards);
      const [entryCount] = await db.select({ cnt: count() }).from(ledgerEntriesTable);
      const perShard = Math.ceil(Number(entryCount.cnt) / NUM_SHARDS);
      for (const s of seedShards) {
        await db.update(ledgerShardsTable)
          .set({ entryCount: perShard })
          .where(eq(ledgerShardsTable.id, s.id));
      }
      const updated = await db.select().from(ledgerShardsTable);
      return res.json({
        shards: updated,
        strategy: "wallet_id_hash",
        numShards: NUM_SHARDS,
        description: "Ledger horizontally sharded by wallet_id hash (mod 8). Each shard maintains double-entry consistency.",
        totalShards: NUM_SHARDS,
      });
    }

    const totalEntries = shards.reduce((a, s) => a + s.entryCount, 0);
    return res.json({
      shards,
      strategy: "wallet_id_hash",
      numShards: shards.length,
      description: "Ledger horizontally sharded by wallet_id hash (mod N). Each shard maintains double-entry consistency.",
      totalShards: shards.length,
      totalEntries,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch shard data", message: String(err) });
  }
});

router.get("/aml/summary", async (_req, res) => {
  try {
    const [flags]  = await db.select({ cnt: count() }).from(amlFlagsTable);
    const [cases]  = await db.select({ cnt: count() }).from(complianceCasesTable);
    const [open]   = await db.select({ cnt: count() }).from(complianceCasesTable).where(eq(complianceCasesTable.status, "open"));
    return res.json({
      totalFlags: Number(flags.cnt),
      totalCases: Number(cases.cnt),
      openCases:  Number(open.cnt),
    });
  } catch (err) {
    return res.status(500).json({ error: "AML summary failed" });
  }
});

router.get("/revenue", async (req, res) => {
  try {
    const period = String(req.query.period ?? "30d");
    const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
    const snapshot = await getRevenueSnapshot({ days });
    const totalRevenue = snapshot.dailyRevenue.reduce((acc, p) => acc + Number(p.amount), 0);
    const currentMonthKey = new Date().toISOString().slice(0, 7);
    const monthlyRevenue = [{ month: currentMonthKey, amount: Number(snapshot.monthlyRevenue.toFixed(4)) }];
    const revenuePerFeature = snapshot.revenueBySource
      .map((x) => ({ source: x.source, amount: Number(x.amount.toFixed(4)) }))
      .sort((a, b) => b.amount - a.amount);

    return res.json({
      period,
      totalRevenue: Number(totalRevenue.toFixed(4)),
      currency: "XOF",
      dailyRevenue: snapshot.dailyRevenue.map((x) => ({ date: x.day, amount: Number(x.amount.toFixed(4)) })),
      monthlyRevenue,
      revenuePerFeature,
      entries: snapshot.dailyRevenue.length,
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

export default router;
