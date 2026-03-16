import { db } from "@workspace/db";
import {
  regulatoryReportsTable,
  reportEntriesTable,
  transactionsTable,
  amlFlagsTable,
} from "@workspace/db";
import { eq, gte, lte, and, sql, desc } from "drizzle-orm";
import { generateId } from "./id";

export type ReportType = "suspicious_activity" | "high_value_transactions" | "daily_transaction_summary";
export type ReportFormat = "json" | "csv";

interface ReportResult {
  reportId:    string;
  reportType:  ReportType;
  format:      ReportFormat;
  recordCount: number;
  data:        unknown[];
  content?:    string;
}

async function fetchSuspiciousActivity(periodStart: Date, periodEnd: Date) {
  const flags = await db.select().from(amlFlagsTable)
    .where(and(gte(amlFlagsTable.createdAt, periodStart), lte(amlFlagsTable.createdAt, periodEnd)));
  return flags.map(f => ({
    flagId:        f.id,
    walletId:      f.walletId,
    transactionId: f.transactionId,
    reason:        f.reason,
    severity:      f.severity,
    reviewed:      f.reviewed,
    reportedAt:    f.createdAt,
  }));
}

async function fetchHighValueTransactions(periodStart: Date, periodEnd: Date, threshold = 10_000_000) {
  const txs = await db.select().from(transactionsTable)
    .where(and(
      gte(transactionsTable.createdAt, periodStart),
      lte(transactionsTable.createdAt, periodEnd),
      sql`${transactionsTable.amount} >= ${String(threshold)}`,
    ));
  return txs.map(t => ({
    transactionId: t.id,
    amount:        t.amount,
    currency:      t.currency,
    type:          t.type,
    status:        t.status,
    reference:     t.reference,
    createdAt:     t.createdAt,
  }));
}

async function fetchDailySummary(periodStart: Date, periodEnd: Date) {
  const rows = await db.select({
    type:       transactionsTable.type,
    currency:   transactionsTable.currency,
    status:     transactionsTable.status,
    cnt:        sql<number>`count(*)`,
    totalAmt:   sql<string>`coalesce(sum(${transactionsTable.amount}),0)`,
  })
    .from(transactionsTable)
    .where(and(gte(transactionsTable.createdAt, periodStart), lte(transactionsTable.createdAt, periodEnd)))
    .groupBy(transactionsTable.type, transactionsTable.currency, transactionsTable.status);

  return rows.map(r => ({
    type:        r.type,
    currency:    r.currency,
    status:      r.status,
    count:       Number(r.cnt),
    totalAmount: Number(r.totalAmt),
  }));
}

function toCSV(data: Record<string, unknown>[]): string {
  if (!data.length) return "";
  const headers = Object.keys(data[0]);
  const lines   = [
    headers.join(","),
    ...data.map(row =>
      headers.map(h => {
        const v = row[h];
        const s = v == null ? "" : String(v);
        return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")
    ),
  ];
  return lines.join("\n");
}

export async function generateReport(
  reportType: ReportType,
  format: ReportFormat = "json",
  opts: { periodStart?: Date; periodEnd?: Date } = {}
): Promise<ReportResult> {
  const periodEnd   = opts.periodEnd   ?? new Date();
  const periodStart = opts.periodStart ?? new Date(periodEnd.getTime() - 86400_000);

  const id = generateId("rrpt");
  await db.insert(regulatoryReportsTable).values({
    id, reportType, status: "generating", format,
    periodStart, periodEnd, recordCount: 0,
  });

  let data: Record<string, unknown>[] = [];
  if (reportType === "suspicious_activity")         data = await fetchSuspiciousActivity(periodStart, periodEnd) as Record<string, unknown>[];
  else if (reportType === "high_value_transactions") data = await fetchHighValueTransactions(periodStart, periodEnd) as Record<string, unknown>[];
  else if (reportType === "daily_transaction_summary") data = await fetchDailySummary(periodStart, periodEnd) as Record<string, unknown>[];

  if (data.length > 0) {
    await db.insert(reportEntriesTable).values(
      data.slice(0, 500).map(d => ({
        id: generateId("rent"),
        reportId:  id,
        entryType: reportType,
        data:      d,
      }))
    );
  }

  await db.update(regulatoryReportsTable).set({
    status: "completed", generatedAt: new Date(), recordCount: data.length,
  }).where(eq(regulatoryReportsTable.id, id));

  const content = format === "csv" ? toCSV(data as Record<string, unknown>[]) : undefined;

  return { reportId: id, reportType, format, recordCount: data.length, data, content };
}

export async function listReports() {
  return db.select().from(regulatoryReportsTable).orderBy(desc(regulatoryReportsTable.createdAt));
}

export async function getReportEntries(reportId: string) {
  return db.select().from(reportEntriesTable).where(eq(reportEntriesTable.reportId, reportId));
}
