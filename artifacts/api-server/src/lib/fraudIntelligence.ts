import { db } from "@workspace/db";
import {
  fraudNetworkNodesTable,
  fraudNetworkEdgesTable,
  fraudScoresTable,
  transactionsTable,
  walletsTable,
} from "@workspace/db";
import { eq, desc, sql, gte, or } from "drizzle-orm";
import { generateId } from "./id";

const MODEL_VERSION = "v2.0";

export async function ensureNode(walletId: string): Promise<string> {
  const existing = await db.select().from(fraudNetworkNodesTable).where(eq(fraudNetworkNodesTable.walletId, walletId)).limit(1);
  if (existing[0]) return existing[0].id;
  const id = generateId("fnn");
  await db.insert(fraudNetworkNodesTable).values({ id, walletId, nodeType: "wallet", riskScore: "0", transactionCount: 0, flaggedCount: 0 });
  return id;
}

export async function recordNetworkEdge(
  fromWalletId: string,
  toWalletId:   string,
  amount:       number,
  currency = "XOF"
): Promise<void> {
  const [fromId, toId] = await Promise.all([ensureNode(fromWalletId), ensureNode(toWalletId)]);
  const existing = await db.select().from(fraudNetworkEdgesTable)
    .where(sql`${fraudNetworkEdgesTable.fromNodeId} = ${fromId} AND ${fraudNetworkEdgesTable.toNodeId} = ${toId}`)
    .limit(1);
  if (existing[0]) {
    await db.update(fraudNetworkEdgesTable).set({
      transactionCount: sql`${fraudNetworkEdgesTable.transactionCount} + 1`,
      totalAmount:      sql`${fraudNetworkEdgesTable.totalAmount} + ${String(amount)}`,
      weight:           sql`${fraudNetworkEdgesTable.weight} + 1`,
      updatedAt:        new Date(),
    }).where(eq(fraudNetworkEdgesTable.id, existing[0].id));
  } else {
    await db.insert(fraudNetworkEdgesTable).values({
      id: generateId("fne"), fromNodeId: fromId, toNodeId: toId,
      edgeType: "transfer", weight: "1", transactionCount: 1,
      totalAmount: String(amount), currency,
    });
  }
  await db.update(fraudNetworkNodesTable)
    .set({ transactionCount: sql`${fraudNetworkNodesTable.transactionCount} + 1`, updatedAt: new Date() })
    .where(eq(fraudNetworkNodesTable.id, fromId));
}

export async function detectBehavioralAnomalies(walletId: string): Promise<{
  anomalies: Array<{ type: string; severity: string; detail: string }>;
  riskScore: number;
}> {
  const anomalies: Array<{ type: string; severity: string; detail: string }> = [];
  const since1h  = new Date(Date.now() - 3600_000);
  const since24h = new Date(Date.now() - 86400_000);

  const [hourlyRows, dailyRows] = await Promise.all([
    db.select({ cnt: sql<number>`count(*)`, total: sql<string>`coalesce(sum(amount),0)` })
      .from(transactionsTable)
      .where(sql`(${transactionsTable.fromWalletId} = ${walletId} OR ${transactionsTable.toWalletId} = ${walletId}) AND ${transactionsTable.createdAt} >= ${since1h}`),
    db.select({ cnt: sql<number>`count(*)`, total: sql<string>`coalesce(sum(amount),0)` })
      .from(transactionsTable)
      .where(sql`(${transactionsTable.fromWalletId} = ${walletId} OR ${transactionsTable.toWalletId} = ${walletId}) AND ${transactionsTable.createdAt} >= ${since24h}`),
  ]);

  const hourlyCnt   = Number(hourlyRows[0]?.cnt  ?? 0);
  const dailyCnt    = Number(dailyRows[0]?.cnt   ?? 0);
  const hourlyTotal = Number(hourlyRows[0]?.total ?? 0);

  if (hourlyCnt >= 10) {
    anomalies.push({ type: "high_frequency", severity: "high", detail: `${hourlyCnt} transactions in last hour` });
  }
  if (dailyCnt >= 50) {
    anomalies.push({ type: "volume_spike", severity: "medium", detail: `${dailyCnt} transactions in last 24h` });
  }
  if (hourlyTotal >= 5_000_000) {
    anomalies.push({ type: "large_hourly_volume", severity: "critical", detail: `${hourlyTotal} XOF moved in last hour` });
  }

  const score = Math.min(100, anomalies.reduce((s, a) => {
    return s + (a.severity === "critical" ? 40 : a.severity === "high" ? 25 : 15);
  }, 0));

  return { anomalies, riskScore: score };
}

export async function detectCrossWalletVelocity(walletIds: string[]): Promise<{
  totalVolume: number;
  txCount: number;
  suspiciousPatterns: string[];
}> {
  const since = new Date(Date.now() - 3600_000);
  const suspiciousPatterns: string[] = [];
  let totalVolume = 0;
  let txCount = 0;

  for (const wid of walletIds) {
    const rows = await db.select({ cnt: sql<number>`count(*)`, vol: sql<string>`coalesce(sum(amount),0)` })
      .from(transactionsTable)
      .where(sql`(${transactionsTable.fromWalletId} = ${wid} OR ${transactionsTable.toWalletId} = ${wid}) AND ${transactionsTable.createdAt} >= ${since}`);
    txCount    += Number(rows[0]?.cnt ?? 0);
    totalVolume += Number(rows[0]?.vol ?? 0);
  }

  if (txCount > 20)       suspiciousPatterns.push("cross_wallet_velocity_exceeded");
  if (totalVolume > 10_000_000) suspiciousPatterns.push("cross_wallet_large_volume");
  if (walletIds.length >= 3 && txCount > 5) suspiciousPatterns.push("ring_pattern_detected");

  return { totalVolume, txCount, suspiciousPatterns };
}

export async function computeFraudScore(walletId: string): Promise<{
  score: number;
  factors: Record<string, number>;
}> {
  const { anomalies, riskScore } = await detectBehavioralAnomalies(walletId);

  const nodeRows = await db.select().from(fraudNetworkNodesTable).where(eq(fraudNetworkNodesTable.walletId, walletId)).limit(1);
  const node = nodeRows[0];

  const edgeCntRows = await db.select({ cnt: sql<number>`count(*)` })
    .from(fraudNetworkEdgesTable)
    .where(sql`${fraudNetworkEdgesTable.fromNodeId} = ${node?.id ?? "__none__"} OR ${fraudNetworkEdgesTable.toNodeId} = ${node?.id ?? "__none__"}`);
  const edgeCnt = Number(edgeCntRows[0]?.cnt ?? 0);

  const factors: Record<string, number> = {
    behavioralAnomaly: riskScore,
    networkDegree:     Math.min(30, edgeCnt * 3),
    flaggedCount:      Math.min(30, (node?.flaggedCount ?? 0) * 10),
    txCount:           Math.min(10, Math.floor((node?.transactionCount ?? 0) / 100)),
  };
  const score = Math.min(100, Object.values(factors).reduce((a, b) => a + b, 0));

  const id = generateId("frs");
  await db.insert(fraudScoresTable).values({ id, walletId, score: String(score), factors, modelVersion: MODEL_VERSION });

  return { score, factors };
}

export async function getNetworkGraph(limit = 100) {
  const [nodes, edges] = await Promise.all([
    db.select().from(fraudNetworkNodesTable).limit(limit),
    db.select().from(fraudNetworkEdgesTable).limit(limit),
  ]);
  return { nodes, edges, nodeCount: nodes.length, edgeCount: edges.length };
}

export async function getTopRiskWallets(n = 10) {
  return db.select().from(fraudScoresTable).orderBy(desc(fraudScoresTable.score)).limit(n);
}
