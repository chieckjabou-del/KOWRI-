import { db } from "@workspace/db";
import {
  reputationScoresTable, tontineMembersTable, tontinesTable,
  loansTable, transactionsTable, usersTable, walletsTable,
  creditScoresTable, merchantsTable, tontinePurchaseGoalsTable,
  tontineAiAssessmentsTable,
} from "@workspace/db";
import { eq, and, sql, count, desc, lt, or } from "drizzle-orm";
import { generateId } from "./id";
import { eventBus } from "./eventBus";

export type ReputationTier = "new" | "bronze" | "silver" | "gold" | "platinum";

type Badge = { badge: string; earnedAt: string; criteria: string };

function tierFromScore(score: number): ReputationTier {
  if (score >= 85) return "platinum";
  if (score >= 70) return "gold";
  if (score >= 50) return "silver";
  if (score >= 25) return "bronze";
  return "new";
}

async function computeBadges(userId: string, params: {
  totalContributions: number;
  tontineParticipation: number;
  totalLoans: number;
  repaidLoans: number;
  score: number;
}): Promise<Badge[]> {
  const now = new Date().toISOString();
  const badges: Badge[] = [];

  // reliable_contributor: 0 missed payments across 5+ cycles
  if (params.totalContributions >= 5 && params.tontineParticipation > 0) {
    const [missedCheck] = await db.select({ missed: sql<number>`SUM(${tontinesTable.totalRounds} - ${tontineMembersTable.contributionsCount})` })
      .from(tontineMembersTable)
      .innerJoin(tontinesTable, eq(tontineMembersTable.tontineId, tontinesTable.id))
      .where(and(eq(tontineMembersTable.userId, userId), eq(tontinesTable.status, "completed")));
    if (Number(missedCheck?.missed ?? 1) === 0) {
      badges.push({ badge: "reliable_contributor", earnedAt: now, criteria: "Zero missed payments across 5+ tontine cycles" });
    }
  }

  // trusted_organizer: admin of 3+ completed tontines
  const [orgCheck] = await db.select({ c: count() }).from(tontinesTable)
    .where(and(eq(tontinesTable.adminUserId, userId), eq(tontinesTable.status, "completed")));
  if (Number(orgCheck?.c ?? 0) >= 3) {
    badges.push({ badge: "trusted_organizer", earnedAt: now, criteria: "Created and completed 3+ tontines as admin" });
  }

  // fast_repayer: all loans repaid, minimum 3
  if (params.totalLoans >= 3 && params.repaidLoans === params.totalLoans) {
    badges.push({ badge: "fast_repayer", earnedAt: now, criteria: "All 3+ loans repaid on time" });
  }

  // community_champion: top 10% (score >= 80)
  if (params.score >= 80) {
    badges.push({ badge: "community_champion", earnedAt: now, criteria: "Top 10% reputation score on the platform" });
  }

  // diaspora_connector: participated in a diaspora tontine
  const [diasporaCheck] = await db.select({ c: count() }).from(tontineMembersTable)
    .innerJoin(tontinesTable, eq(tontineMembersTable.tontineId, tontinesTable.id))
    .where(and(eq(tontineMembersTable.userId, userId), eq(tontinesTable.tontineType, "diaspora")));
  if (Number(diasporaCheck?.c ?? 0) > 0) {
    badges.push({ badge: "diaspora_connector", earnedAt: now, criteria: "Participated in a multi-country diaspora tontine" });
  }

  return badges;
}

export async function computeReputationScore(userId: string): Promise<typeof reputationScoresTable.$inferSelect> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) throw new Error(`User ${userId} not found`);

  const [tontineStats] = await db.select({
    total:         count(),
    received:      sql<number>`SUM(CASE WHEN ${tontineMembersTable.hasReceivedPayout} = 1 THEN 1 ELSE 0 END)`,
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

  const accountAgeMs     = Date.now() - new Date(user.createdAt).getTime();
  const accountAgeMonths = (accountAgeMs / (1000 * 60 * 60 * 24)) / 30;

  const contributionRate = tontineParticipation > 0
    ? Math.min(100, (totalContributions / (tontineParticipation * 6)) * 100) : 0;
  const repaymentRate    = totalLoans > 0 ? (repaidLoans / totalLoans) * 100 : 50;

  const longevityScore      = Math.min(20, Math.floor(accountAgeMonths / 1.5));
  const regularityScore     = Math.min(20, Math.floor(txCount / 5));
  const tontineScore        = Math.min(25, tontineParticipation * 5);
  const repaymentContrib    = Math.round((repaymentRate / 100) * 25);
  const contributionContrib = Math.round((contributionRate / 100) * 10);
  const reciprocityScore    = Math.min(15, Math.floor(txCount / 10));

  const score = Math.min(100,
    longevityScore + regularityScore + tontineScore + repaymentContrib + contributionContrib + reciprocityScore
  );
  const tier   = tierFromScore(score);
  const badges = await computeBadges(userId, { totalContributions, tontineParticipation, totalLoans, repaidLoans, score });

  const existing = await db.select().from(reputationScoresTable).where(eq(reputationScoresTable.userId, userId));
  let result: typeof reputationScoresTable.$inferSelect;

  if (existing[0]) {
    const [updated] = await db.update(reputationScoresTable).set({
      score,
      contributionRate: String(contributionRate.toFixed(2)),
      repaymentRate:    String(repaymentRate.toFixed(2)),
      reciprocityScore, longevityScore, regularityScore, tontineScore,
      tier, badges,
      calculatedAt:     new Date(),
    }).where(eq(reputationScoresTable.userId, userId)).returning();
    result = updated;
  } else {
    const [created] = await db.insert(reputationScoresTable).values({
      id: generateId(), userId, score,
      contributionRate: String(contributionRate.toFixed(2)),
      repaymentRate:    String(repaymentRate.toFixed(2)),
      reciprocityScore, longevityScore, regularityScore, tontineScore,
      tier, badges,
    }).returning();
    result = created;
  }

  await eventBus.publish("reputation.score.updated", { userId, score, tier, badgeCount: badges.length });
  return result;
}

export async function getReputationScore(userId: string) {
  const [score] = await db.select().from(reputationScoresTable).where(eq(reputationScoresTable.userId, userId));
  return score ?? null;
}

export async function computeCreditScoreFromActivity(userId: string): Promise<{
  paymentHistory: number; savingsRegularity: number; transactionVolume: number;
  tontineParticipation: number; networkScore: number; composite: number;
}> {
  const reputation = await computeReputationScore(userId);

  const [loanStats] = await db.select({
    total:  count(),
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

  const paymentHistory       = totalLoans > 0 ? Math.round((repaidLoans / totalLoans) * 100) : 50;
  const savingsRegularity    = Math.min(100, Number(depositCount?.total ?? 0) * 5);
  const transactionVolume    = Math.min(100, Number(txCount?.total ?? 0) * 2);
  const tontineParticipation = Math.min(100, reputation.tontineScore * 4);
  const networkScore         = Math.min(100, reputation.reciprocityScore * 6);

  const composite = Math.round(
    paymentHistory * 0.30 + savingsRegularity * 0.20 +
    transactionVolume * 0.20 + tontineParticipation * 0.20 + networkScore * 0.10
  );

  return { paymentHistory, savingsRegularity, transactionVolume, tontineParticipation, networkScore, composite };
}

// ── AI Priority Scoring ────────────────────────────────────────────────────────

export async function computeTontineAIPriority(tontineId: string): Promise<
  Array<typeof tontineAiAssessmentsTable.$inferSelect & { rank: number }>
> {
  const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
  if (!tontine) throw new Error(`Tontine ${tontineId} not found`);

  const members = await db.select().from(tontineMembersTable).where(eq(tontineMembersTable.tontineId, tontineId));
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const assessments: Array<typeof tontineAiAssessmentsTable.$inferSelect & { rank: number }> = [];

  for (const member of members) {
    const userId = member.userId;

    // 1. Credit score (300–850 range → 0–15 factor)
    const [credit] = await db.select({ score: creditScoresTable.score })
      .from(creditScoresTable).where(eq(creditScoresTable.userId, userId));
    const rawCredit  = Number(credit?.score ?? 300);
    const creditFactor = Math.max(0, Math.min(15, ((rawCredit - 300) / 550) * 15));

    // 2. Reputation score (0–100 → 0–10 factor)
    const [rep] = await db.select({ score: reputationScoresTable.score })
      .from(reputationScoresTable).where(eq(reputationScoresTable.userId, userId));
    const rawRep = Number(rep?.score ?? 0);
    const reputationFactor = Math.min(10, (rawRep / 100) * 10);

    // 3. Financial need score (max ~60 pts, capped at 50)
    const userWallets = await db.select({ balance: walletsTable.balance })
      .from(walletsTable)
      .where(and(eq(walletsTable.userId, userId), eq(walletsTable.walletType, "personal"), eq(walletsTable.status, "active")));
    const personalBalance = userWallets.reduce((s, w) => s + Number(w.balance), 0);
    const needLowBalance  = personalBalance < 10000 ? 30 : 0;

    const [activeLoans] = await db.select({ c: count() }).from(loansTable)
      .where(and(eq(loansTable.userId, userId), or(eq(loansTable.status, "disbursed"), eq(loansTable.status, "approved"))));
    const needActiveLoan = Number(activeLoans?.c ?? 0) > 0 ? 20 : 0;

    const [recentLargeTx] = await db.select({ c: count() }).from(transactionsTable)
      .where(sql`${transactionsTable.fromWalletId} IN (SELECT id FROM wallets WHERE user_id = ${userId})
        AND ${transactionsTable.status} = 'completed'
        AND ${transactionsTable.amount}::numeric >= 50000
        AND ${transactionsTable.createdAt} >= ${thirtyDaysAgo}`);
    const needRecentExpenses = Number(recentLargeTx?.c ?? 0) > 0 ? 10 : 0;

    const needScore = Math.min(50, needLowBalance + needActiveLoan + needRecentExpenses);

    // 4. Project score (max 40 pts)
    const [activeGoals] = await db.select({ c: count() }).from(tontinePurchaseGoalsTable)
      .where(and(eq(tontinePurchaseGoalsTable.tontineId, tontineId), eq(tontinePurchaseGoalsTable.status, "open")));
    const projectGoal = Number(activeGoals?.c ?? 0) > 0 ? 25 : 0;

    const [merchant] = await db.select({ totalRevenue: merchantsTable.totalRevenue })
      .from(merchantsTable)
      .where(and(eq(merchantsTable.userId, userId), eq(merchantsTable.status, "active")));
    const projectMerchant = merchant && Number(merchant.totalRevenue) < 100000 ? 15 : 0;
    const projectScore = Math.min(40, projectGoal + projectMerchant);

    // 5. priority_score = weighted sum (0–100)
    const priorityScore = Math.min(100, creditFactor + reputationFactor + needScore + projectScore);

    // 6. Human-readable recommendation
    const factors: string[] = [];
    if (needLowBalance)       factors.push(`low wallet balance (${personalBalance.toFixed(0)} XOF)`);
    if (needActiveLoan)       factors.push("has active loan");
    if (needRecentExpenses)   factors.push("recent large expenses");
    if (projectGoal)          factors.push("linked to active purchase goal");
    if (projectMerchant)      factors.push("low-revenue merchant");
    if (rawRep >= 70)         factors.push(`high reputation (${rawRep}/100)`);
    if (rawCredit >= 600)     factors.push(`good credit (${rawCredit}/850)`);
    const recommendation = factors.length > 0
      ? `Priority ${priorityScore.toFixed(0)}/100 — ${factors.join(", ")}`
      : `Priority ${priorityScore.toFixed(0)}/100 — standard profile`;

    // Upsert assessment
    const existing = await db.select().from(tontineAiAssessmentsTable)
      .where(and(eq(tontineAiAssessmentsTable.tontineId, tontineId), eq(tontineAiAssessmentsTable.userId, userId)));

    let saved: typeof tontineAiAssessmentsTable.$inferSelect;
    const payload = {
      tontineId, userId,
      priorityScore: String(priorityScore.toFixed(2)),
      factors:        { creditScore: rawCredit, reputationScore: rawRep, needScore, projectScore, creditFactor, reputationFactor },
      recommendation,
      assessedAt:    new Date(),
      applied:       false,
    };

    if (existing[0]) {
      const [updated] = await db.update(tontineAiAssessmentsTable).set(payload)
        .where(eq(tontineAiAssessmentsTable.id, existing[0].id)).returning();
      saved = updated;
    } else {
      const [created] = await db.insert(tontineAiAssessmentsTable).values({ id: generateId(), ...payload }).returning();
      saved = created;
    }

    assessments.push({ ...saved, rank: 0 });
  }

  // Rank by priorityScore descending
  assessments.sort((a, b) => Number(b.priorityScore) - Number(a.priorityScore));
  assessments.forEach((a, i) => { a.rank = i + 1; });

  return assessments;
}
