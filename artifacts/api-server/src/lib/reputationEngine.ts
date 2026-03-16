import { db } from "@workspace/db";
import {
  reputationScoresTable, tontineMembersTable, tontinesTable,
  loansTable, transactionsTable, usersTable,
} from "@workspace/db";
import { eq, and, sql, count } from "drizzle-orm";
import { generateId } from "./id";
import { eventBus } from "./eventBus";

export type ReputationTier = "new" | "bronze" | "silver" | "gold" | "platinum";

function tierFromScore(score: number): ReputationTier {
  if (score >= 85) return "platinum";
  if (score >= 70) return "gold";
  if (score >= 50) return "silver";
  if (score >= 25) return "bronze";
  return "new";
}

export async function computeReputationScore(userId: string): Promise<typeof reputationScoresTable.$inferSelect> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) throw new Error(`User ${userId} not found`);

  const [tontineStats] = await db.select({
    total: count(),
    received: sql<number>`SUM(CASE WHEN ${tontineMembersTable.hasReceivedPayout} = 1 THEN 1 ELSE 0 END)`,
    contributions: sql<number>`SUM(${tontineMembersTable.contributionsCount})`,
  }).from(tontineMembersTable).where(eq(tontineMembersTable.userId, userId));

  const tontineParticipation = Number(tontineStats?.total ?? 0);
  const totalContributions   = Number(tontineStats?.contributions ?? 0);

  const [loanStats] = await db.select({
    total:  count(),
    repaid: sql<number>`SUM(CASE WHEN ${loansTable.status} = 'repaid' THEN 1 ELSE 0 END)`,
  }).from(loansTable).where(eq(loansTable.userId, userId));

  const totalLoans  = Number(loanStats?.total ?? 0);
  const repaidLoans = Number(loanStats?.repaid ?? 0);

  const [txStats] = await db.select({ total: count() })
    .from(transactionsTable)
    .where(sql`(${transactionsTable.fromWalletId} IN (SELECT id FROM wallets WHERE user_id = ${userId}) OR ${transactionsTable.toWalletId} IN (SELECT id FROM wallets WHERE user_id = ${userId})) AND ${transactionsTable.status} = 'completed'`);

  const txCount = Number(txStats?.total ?? 0);

  const accountAgeMs    = Date.now() - new Date(user.createdAt).getTime();
  const accountAgeDays  = accountAgeMs / (1000 * 60 * 60 * 24);
  const accountAgeMonths = accountAgeDays / 30;

  const contributionRate = tontineParticipation > 0
    ? Math.min(100, (totalContributions / (tontineParticipation * 6)) * 100) : 0;

  const repaymentRate = totalLoans > 0
    ? (repaidLoans / totalLoans) * 100 : 50;

  const longevityScore   = Math.min(20, Math.floor(accountAgeMonths / 1.5));
  const regularityScore  = Math.min(20, Math.floor(txCount / 5));
  const tontineScore     = Math.min(25, tontineParticipation * 5);
  const repaymentContrib = Math.round((repaymentRate / 100) * 25);
  const contributionContrib = Math.round((contributionRate / 100) * 10);

  const reciprocityScore = Math.min(15, Math.floor(txCount / 10));

  const score = Math.min(100,
    longevityScore + regularityScore + tontineScore + repaymentContrib + contributionContrib + reciprocityScore
  );

  const tier = tierFromScore(score);

  const existing = await db.select().from(reputationScoresTable).where(eq(reputationScoresTable.userId, userId));

  let result: typeof reputationScoresTable.$inferSelect;

  if (existing[0]) {
    const [updated] = await db.update(reputationScoresTable).set({
      score,
      contributionRate: String(contributionRate.toFixed(2)),
      repaymentRate:    String(repaymentRate.toFixed(2)),
      reciprocityScore,
      longevityScore,
      regularityScore,
      tontineScore,
      tier,
      calculatedAt: new Date(),
    }).where(eq(reputationScoresTable.userId, userId)).returning();
    result = updated;
  } else {
    const [created] = await db.insert(reputationScoresTable).values({
      id:               generateId(),
      userId,
      score,
      contributionRate: String(contributionRate.toFixed(2)),
      repaymentRate:    String(repaymentRate.toFixed(2)),
      reciprocityScore,
      longevityScore,
      regularityScore,
      tontineScore,
      tier,
    }).returning();
    result = created;
  }

  await eventBus.publish("reputation.score.updated", { userId, score, tier });
  return result;
}

export async function getReputationScore(userId: string) {
  const [score] = await db.select().from(reputationScoresTable)
    .where(eq(reputationScoresTable.userId, userId));
  return score ?? null;
}

export async function computeCreditScoreFromActivity(userId: string): Promise<{
  paymentHistory: number; savingsRegularity: number; transactionVolume: number;
  tontineParticipation: number; networkScore: number; composite: number;
}> {
  const reputation = await computeReputationScore(userId);

  const [loanStats] = await db.select({
    total: count(),
    repaid: sql<number>`SUM(CASE WHEN ${loansTable.status} = 'repaid' THEN 1 ELSE 0 END)`,
  }).from(loansTable).where(eq(loansTable.userId, userId));

  const totalLoans  = Number(loanStats?.total ?? 0);
  const repaidLoans = Number(loanStats?.repaid ?? 0);

  const [txCount] = await db.select({ total: count() })
    .from(transactionsTable)
    .where(sql`${transactionsTable.fromWalletId} IN (SELECT id FROM wallets WHERE user_id = ${userId}) AND ${transactionsTable.status} = 'completed'`);

  const [depositCount] = await db.select({ total: count() })
    .from(transactionsTable)
    .where(sql`${transactionsTable.toWalletId} IN (SELECT id FROM wallets WHERE user_id = ${userId}) AND ${transactionsTable.type} = 'deposit' AND ${transactionsTable.status} = 'completed'`);

  const paymentHistory     = totalLoans > 0 ? Math.round((repaidLoans / totalLoans) * 100) : 50;
  const savingsRegularity  = Math.min(100, Number(depositCount?.total ?? 0) * 5);
  const transactionVolume  = Math.min(100, Number(txCount?.total ?? 0) * 2);
  const tontineParticipation = Math.min(100, reputation.tontineScore * 4);
  const networkScore       = Math.min(100, reputation.reciprocityScore * 6);

  const composite = Math.round(
    paymentHistory * 0.30 +
    savingsRegularity * 0.20 +
    transactionVolume * 0.20 +
    tontineParticipation * 0.20 +
    networkScore * 0.10
  );

  return { paymentHistory, savingsRegularity, transactionVolume, tontineParticipation, networkScore, composite };
}
