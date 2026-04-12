import { db } from "@workspace/db";
import {
  creditScoresTable,
  feeConfigTable,
  floatAccountsTable,
  floatOperationsTable,
  floatPoliciesTable,
  fxTransactionsTable,
  premiumSubscriptionsTable,
  revenueLogsTable,
  usersTable,
  type FeeOperationType,
} from "@workspace/db";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { generateId } from "./id";

export type FeeType =
  | "withdrawal_fee"
  | "express_payout_fee"
  | "transfer_fee"
  | "bid_fee"
  | "fx_margin_fee";

type RevenueSource = "fees" | "bids" | "penalties" | "fx" | "loan_interest" | "subscription";

const PREMIUM_FEE_DISCOUNT_BPS = 2000; // 20%
const FX_MARGIN_BPS_DEFAULT = 150; // 1.5%
const MIN_BID_FEE_BPS = 100; // 1%

function toAmount(n: unknown): number {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, v);
}

function mapFeeTypeToOperation(feeType: FeeType): FeeOperationType {
  switch (feeType) {
    case "withdrawal_fee":
      return "cashout";
    case "express_payout_fee":
      return "tontine_payout";
    case "transfer_fee":
      return "merchant_payment";
    case "fx_margin_fee":
      return "diaspora_transfer";
    case "bid_fee":
      return "merchant_payment";
  }
}

async function getUserTier(userId?: string): Promise<"all" | "bronze" | "silver" | "gold" | "platinum"> {
  if (!userId) return "all";
  const [score] = await db
    .select({ tier: creditScoresTable.tier })
    .from(creditScoresTable)
    .where(eq(creditScoresTable.userId, userId))
    .limit(1);
  return (score?.tier as any) ?? "all";
}

export async function ensureMonetizationConfigSeeded(): Promise<void> {
  const [existing] = await db.select({ id: feeConfigTable.id }).from(feeConfigTable).limit(1);
  if (existing) return;

  await db.insert(feeConfigTable).values([
    {
      id: generateId("fee"),
      operationType: "cashout",
      minAmount: "0",
      maxAmount: null,
      feeRateBps: 150,
      feeMinAbs: "0",
      feeMaxAbs: null,
      userTier: "all",
      active: true,
    },
    {
      id: generateId("fee"),
      operationType: "tontine_payout",
      minAmount: "0",
      maxAmount: null,
      feeRateBps: 120,
      feeMinAbs: "0",
      feeMaxAbs: null,
      userTier: "all",
      active: true,
    },
    {
      id: generateId("fee"),
      operationType: "merchant_payment",
      minAmount: "0",
      maxAmount: null,
      feeRateBps: 80,
      feeMinAbs: "0",
      feeMaxAbs: null,
      userTier: "all",
      active: true,
    },
    {
      id: generateId("fee"),
      operationType: "diaspora_transfer",
      minAmount: "0",
      maxAmount: null,
      feeRateBps: FX_MARGIN_BPS_DEFAULT,
      feeMinAbs: "0",
      feeMaxAbs: null,
      userTier: "all",
      active: true,
    },
    {
      id: generateId("fee"),
      operationType: "loan_disbursement",
      minAmount: "0",
      maxAmount: null,
      feeRateBps: 250,
      feeMinAbs: "0",
      feeMaxAbs: null,
      userTier: "all",
      active: true,
    },
  ]);
}

export async function isPremiumActive(userId: string): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .select()
    .from(premiumSubscriptionsTable)
    .where(and(eq(premiumSubscriptionsTable.userId, userId), eq(premiumSubscriptionsTable.status, "active")))
    .limit(1);
  if (!row) return false;
  return new Date(row.expiresAt).getTime() > now.getTime();
}

export async function getEffectiveFeeBps(
  operationType: FeeOperationType,
  amount: number,
  userId?: string,
): Promise<number> {
  await ensureMonetizationConfigSeeded();

  const amountStr = String(toAmount(amount));
  const userTier = await getUserTier(userId);
  const rules = await db
    .select()
    .from(feeConfigTable)
    .where(
      and(
        eq(feeConfigTable.operationType, operationType),
        eq(feeConfigTable.active, true),
        lte(feeConfigTable.minAmount, amountStr),
        or(isNull(feeConfigTable.maxAmount), gte(feeConfigTable.maxAmount, amountStr)),
        or(eq(feeConfigTable.userTier, "all"), eq(feeConfigTable.userTier, userTier)),
      ),
    )
    .orderBy(desc(feeConfigTable.userTier), desc(feeConfigTable.minAmount))
    .limit(1);

  let bps = Number(rules[0]?.feeRateBps ?? 0);
  if (userId && await isPremiumActive(userId)) {
    bps = Math.max(0, Math.floor((bps * (10_000 - PREMIUM_FEE_DISCOUNT_BPS)) / 10_000));
  }
  return bps;
}

export async function applySmartFee(params: {
  feeType: FeeType;
  amount: number;
  userId?: string;
}): Promise<{ feeAmount: number; netAmount: number; rateBps: number }> {
  const amount = toAmount(params.amount);
  const op = mapFeeTypeToOperation(params.feeType);
  let rateBps = await getEffectiveFeeBps(op, amount, params.userId);
  if (params.feeType === "bid_fee" && rateBps < MIN_BID_FEE_BPS) {
    rateBps = MIN_BID_FEE_BPS;
  }
  const feeAmount = Number(((amount * rateBps) / 10_000).toFixed(4));
  return {
    feeAmount,
    netAmount: Number((amount - feeAmount).toFixed(4)),
    rateBps,
  };
}

export async function getFeeValueNumber(feeType: FeeType, amount: number, userId?: string): Promise<number> {
  const { feeAmount } = await applySmartFee({ feeType, amount, userId });
  return feeAmount;
}

export async function holdFloatOperation(
  source: "tontine" | "wallet" | "deposit" | "bid" | "penalty" | "fx",
  sourceRef: string,
  amount: number,
  opts: {
    currency?: string;
    userId?: string | null;
    holdingPeriodMinutes?: number;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<typeof floatOperationsTable.$inferSelect> {
  const now = new Date();
  const [policy] = await db.select().from(floatPoliciesTable).where(eq(floatPoliciesTable.source, source)).limit(1);
  const holdMins = opts.holdingPeriodMinutes
    ?? (policy?.active ? Number(policy.holdingPeriodMinutes) : undefined)
    ?? Number(process.env.TONTINE_HOLDING_MINUTES ?? 60);
  const releaseAt = new Date(now.getTime() + holdMins * 60_000);

  const [row] = await db.insert(floatOperationsTable).values({
    id: generateId("flt"),
    source,
    sourceRef,
    amount: String(toAmount(amount)),
    currency: opts.currency ?? "XOF",
    userId: opts.userId ?? null,
    heldAt: now,
    releaseAt,
    status: "held",
    metadata: opts.metadata ?? null,
  }).returning();

  await db.insert(floatAccountsTable).values({
    id: generateId("fltacc"),
    currency: opts.currency ?? "XOF",
    totalHeld: String(toAmount(amount)),
    totalReleased: "0",
  }).onConflictDoUpdate({
    target: floatAccountsTable.currency,
    set: {
      totalHeld: sql`${floatAccountsTable.totalHeld}::numeric + ${String(toAmount(amount))}`,
      updatedAt: new Date(),
    },
  });

  return row;
}

export async function releaseFloatOperation(
  sourceRef: string,
  opts: {
    releaseNow?: boolean;
    holdingDelayMinutes?: number;
    releasedAmount?: number;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<typeof floatOperationsTable.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(floatOperationsTable)
    .where(and(eq(floatOperationsTable.sourceRef, sourceRef), eq(floatOperationsTable.status, "held")))
    .orderBy(desc(floatOperationsTable.heldAt))
    .limit(1);
  if (!row) return null;

  const delayMs = (opts.holdingDelayMinutes ?? 0) * 60_000;
  if (!opts.releaseNow) {
    const releasableAt = new Date(row.releaseAt).getTime() + delayMs;
    if (Date.now() < releasableAt) return row;
  }

  const mergedMetadata = {
    ...((row.metadata as Record<string, unknown> | null) ?? {}),
    ...(opts.metadata ?? {}),
    releasedAmount: opts.releasedAmount ?? null,
  };

  const [updated] = await db.update(floatOperationsTable).set({
    status: "released",
    releasedAt: new Date(),
    metadata: mergedMetadata,
  }).where(eq(floatOperationsTable.id, row.id)).returning();

  const releasedAmount = toAmount(opts.releasedAmount ?? Number(row.amount));
  await db.update(floatAccountsTable).set({
    totalHeld: sql`GREATEST(0, ${floatAccountsTable.totalHeld}::numeric - ${String(releasedAmount)})`,
    totalReleased: sql`${floatAccountsTable.totalReleased}::numeric + ${String(releasedAmount)}`,
    updatedAt: new Date(),
  }).where(eq(floatAccountsTable.currency, row.currency));

  return updated;
}

export async function trackRevenue(params: {
  source: RevenueSource;
  feature: string;
  amount: number;
  currency?: string;
  userId?: string | null;
  reference?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<typeof revenueLogsTable.$inferSelect> {
  const [row] = await db.insert(revenueLogsTable).values({
    id: generateId("rev"),
    source: params.source,
    feature: params.feature,
    amount: String(toAmount(params.amount)),
    currency: params.currency ?? "XOF",
    userId: params.userId ?? null,
    reference: params.reference ?? null,
    metadata: params.metadata ?? null,
    timestamp: new Date(),
  }).returning();
  return row;
}

export async function logRevenue(params: {
  source: RevenueSource;
  feature: string;
  amount: number;
  currency?: string;
  userId?: string | null;
  reference?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<typeof revenueLogsTable.$inferSelect> {
  return trackRevenue(params);
}

export async function applyOperationFee(params: {
  operationType: FeeOperationType;
  amount: number;
  currency?: string;
  userId?: string;
  feature?: string;
  reference?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ feeAmount: number; netAmount: number; rateBps: number }> {
  const amount = toAmount(params.amount);
  const rateBps = await getEffectiveFeeBps(params.operationType, amount, params.userId);
  const feeAmount = Number(((amount * rateBps) / 10_000).toFixed(4));
  const netAmount = Number((amount - feeAmount).toFixed(4));

  if (feeAmount > 0) {
    await trackRevenue({
      source: "fees",
      feature: params.feature ?? params.operationType,
      amount: feeAmount,
      currency: params.currency ?? "XOF",
      userId: params.userId ?? null,
      reference: params.reference ?? null,
      metadata: params.metadata,
    });
  }
  return { feeAmount, netAmount, rateBps };
}

export async function applyBidFeeAndLogRevenue(params: {
  userId: string;
  tontineId: string;
  bidAmount: number;
  fromWalletId?: string;
  tontineWalletId?: string;
  currency?: string;
}): Promise<{ feeAmount: number; netBidAmount: number; rateBps: number }> {
  const { feeAmount, netAmount, rateBps } = await applySmartFee({
    feeType: "bid_fee",
    amount: params.bidAmount,
    userId: params.userId,
  });

  if (feeAmount > 0) {
    await trackRevenue({
      source: "bids",
      feature: "tontine_bid",
      amount: feeAmount,
      currency: params.currency ?? "XOF",
      userId: params.userId,
      reference: params.tontineId,
      metadata: {
        bidAmount: params.bidAmount,
        rateBps,
        fromWalletId: params.fromWalletId ?? null,
        tontineWalletId: params.tontineWalletId ?? null,
      },
    });
  }

  return { feeAmount, netBidAmount: netAmount, rateBps };
}

export async function trackFxFeeRevenue(params: {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  amount: number;
  fee: number;
  userId?: string | null;
  txId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const baseAmount = toAmount(params.amount);
  const convertedAmount = Number((baseAmount * Number(params.rate || 1)).toFixed(4));

  await db.insert(fxTransactionsTable).values({
    id: generateId("fx"),
    userId: params.userId ?? null,
    fromCurrency: params.fromCurrency,
    toCurrency: params.toCurrency,
    amount: String(baseAmount),
    convertedAmount: String(convertedAmount),
    rate: String(params.rate),
    fee: String(toAmount(params.fee)),
    reference: params.txId ?? null,
    metadata: params.metadata ?? null,
    createdAt: new Date(),
  });

  if (params.fee > 0) {
    await trackRevenue({
      source: "fx",
      feature: "diaspora_fx",
      amount: params.fee,
      userId: params.userId ?? null,
      reference: params.txId ?? null,
      metadata: {
        fromCurrency: params.fromCurrency,
        toCurrency: params.toCurrency,
        rate: params.rate,
        amount: baseAmount,
      },
    });
  }
}

export async function listFxTransactions(params: {
  fromCurrency?: string;
  toCurrency?: string;
  limit?: number;
} = {}): Promise<Array<{
  id: string;
  fromCurrency: string;
  toCurrency: string;
  amount: number;
  convertedAmount: number;
  rate: number;
  fee: number;
  reference: string | null;
  createdAt: Date;
}>> {
  const max = Math.min(Math.max(1, Number(params.limit ?? 100)), 500);
  const rows = await db
    .select()
    .from(fxTransactionsTable)
    .orderBy(desc(fxTransactionsTable.createdAt))
    .limit(max);

  return rows
    .filter((r) => !params.fromCurrency || r.fromCurrency === params.fromCurrency)
    .filter((r) => !params.toCurrency || r.toCurrency === params.toCurrency)
    .map((r) => ({
      id: r.id,
      fromCurrency: r.fromCurrency,
      toCurrency: r.toCurrency,
      amount: Number(r.amount),
      convertedAmount: Number(r.convertedAmount),
      rate: Number(r.rate),
      fee: Number(r.fee),
      reference: r.reference,
      createdAt: r.createdAt,
    }));
}

export async function createOrRenewPremium(params: {
  userId: string;
  plan: "starter" | "pro" | "elite";
  durationDays?: number;
  amount?: number;
  currency?: string;
}): Promise<typeof premiumSubscriptionsTable.$inferSelect> {
  const durationDays = params.durationDays ?? (params.plan === "elite" ? 365 : params.plan === "pro" ? 180 : 30);
  const now = new Date();
  const [existing] = await db
    .select()
    .from(premiumSubscriptionsTable)
    .where(eq(premiumSubscriptionsTable.userId, params.userId))
    .limit(1);

  const start = existing && new Date(existing.expiresAt).getTime() > now.getTime()
    ? new Date(existing.expiresAt)
    : now;
  const expires = new Date(start);
  expires.setDate(expires.getDate() + durationDays);
  const amount = params.amount ?? (params.plan === "starter" ? 1000 : params.plan === "pro" ? 3000 : 9000);

  let result: typeof premiumSubscriptionsTable.$inferSelect;
  if (existing) {
    const [updated] = await db.update(premiumSubscriptionsTable).set({
      plan: params.plan,
      status: "active",
      expiresAt: expires,
      updatedAt: new Date(),
    }).where(eq(premiumSubscriptionsTable.id, existing.id)).returning();
    result = updated;
  } else {
    const [created] = await db.insert(premiumSubscriptionsTable).values({
      id: generateId("prem"),
      userId: params.userId,
      plan: params.plan,
      status: "active",
      expiresAt: expires,
      createdAt: now,
      updatedAt: now,
    }).returning();
    result = created;
  }

  await trackRevenue({
    source: "subscription",
    feature: "premium_subscription",
    amount,
    currency: params.currency ?? "XOF",
    userId: params.userId,
    reference: result.id,
    metadata: { plan: params.plan, durationDays },
  });

  return result;
}

export async function getRatingContext(
  userId: string,
): Promise<{ ratingScore: number; eligible: boolean; threshold: number }> {
  const threshold = Number(process.env.RATING_SCORE_THRESHOLD ?? 300);
  const [user] = await db
    .select({ ratingScore: usersTable.ratingScore })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const ratingScore = Number(user?.ratingScore ?? 100);
  return { ratingScore, eligible: ratingScore >= threshold, threshold };
}

export async function updateUserReliabilityScore(userId: string, delta: number): Promise<number> {
  const [updated] = await db
    .update(usersTable)
    .set({
      ratingScore: sql`GREATEST(0, LEAST(1000, COALESCE(${usersTable.ratingScore}, 100) + ${delta}))`,
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, userId))
    .returning({ ratingScore: usersTable.ratingScore });
  return Number(updated?.ratingScore ?? 100);
}

export async function computeDynamicMaxLoan(userId: string): Promise<number> {
  const [credit] = await db
    .select({
      score: creditScoresTable.score,
      txVolume: creditScoresTable.transactionVolume,
      tontineParticipation: creditScoresTable.tontineParticipation,
    })
    .from(creditScoresTable)
    .where(eq(creditScoresTable.userId, userId))
    .limit(1);

  const [user] = await db
    .select({ ratingScore: usersTable.ratingScore })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  const score = Number(credit?.score ?? 300);
  const activity = Number(credit?.txVolume ?? 0) + Number(credit?.tontineParticipation ?? 0) + Number(user?.ratingScore ?? 100);
  const maxLoan = Math.max(10_000, Math.min(5_000_000, score * 500 + activity * 5));
  return Math.round(maxLoan);
}

export async function getRevenueSnapshot(params: { days?: number } = {}): Promise<{
  dailyRevenue: Array<{ day: string; amount: number }>;
  monthlyRevenue: number;
  revenueBySource: Array<{ source: string; amount: number }>;
}> {
  const days = params.days ?? 30;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const dailyRows = await db.execute(sql`
    SELECT DATE(timestamp) AS day, COALESCE(SUM(CAST(amount AS NUMERIC)), 0) AS amount
    FROM revenue_logs
    WHERE timestamp >= ${since}
    GROUP BY DATE(timestamp)
    ORDER BY DATE(timestamp) ASC
  `);

  const sourceRows = await db.execute(sql`
    SELECT source, COALESCE(SUM(CAST(amount AS NUMERIC)), 0) AS amount
    FROM revenue_logs
    WHERE timestamp >= ${since}
    GROUP BY source
    ORDER BY amount DESC
  `);

  const monthlyRows = await db.execute(sql`
    SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0) AS amount
    FROM revenue_logs
    WHERE timestamp >= DATE_TRUNC('month', NOW())
  `);

  const dailyRevenue = (dailyRows as any).rows.map((r: any) => ({
    day: String(r.day),
    amount: Number(r.amount ?? 0),
  }));
  const revenueBySource = (sourceRows as any).rows.map((r: any) => ({
    source: String(r.source),
    amount: Number(r.amount ?? 0),
  }));
  const monthlyRevenue = Number((monthlyRows as any).rows?.[0]?.amount ?? 0);

  return { dailyRevenue, monthlyRevenue, revenueBySource };
}

export async function listRevenueBySourceSummary(days = 30): Promise<Array<{ source: string; amount: number }>> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const rows = await db.execute(sql`
    SELECT source, COALESCE(SUM(CAST(amount AS NUMERIC)), 0) AS amount
    FROM revenue_logs
    WHERE timestamp >= ${since}
    GROUP BY source
    ORDER BY amount DESC
  `);
  return (rows as any).rows.map((r: any) => ({
    source: String(r.source),
    amount: Number(r.amount ?? 0),
  }));
}
