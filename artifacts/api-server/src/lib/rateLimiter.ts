import { db } from "@workspace/db";
import { walletLimitsTable, transactionsTable } from "@workspace/db";
import { eq, gte, and, sql } from "drizzle-orm";

export class RateLimitExceededError extends Error {
  constructor(
    public readonly reason: string,
    public readonly limit: number,
    public readonly current: number,
    public readonly windowDesc: string
  ) {
    super(`Rate limit exceeded: ${reason} (${current}/${limit} in ${windowDesc})`);
    this.name = "RateLimitExceededError";
  }
}

interface WalletLimits {
  maxTxPerMinute: number;
  maxHourlyVolume: number;
  maxDailyVolume: number;
}

const DEFAULTS: WalletLimits = {
  maxTxPerMinute: 10,
  maxHourlyVolume: 5_000_000,
  maxDailyVolume: 20_000_000,
};

async function getLimits(walletId: string): Promise<WalletLimits> {
  const [row] = await db.select().from(walletLimitsTable).where(eq(walletLimitsTable.walletId, walletId));
  if (!row) return DEFAULTS;
  return {
    maxTxPerMinute: row.maxTxPerMinute,
    maxHourlyVolume: Number(row.maxHourlyVolume),
    maxDailyVolume: Number(row.maxDailyVolume),
  };
}

export async function checkRateLimit(walletId: string, transferAmount: number): Promise<void> {
  const limits = await getLimits(walletId);

  const now = new Date();
  const oneMinAgo  = new Date(now.getTime() -  60 * 1000);
  const oneHourAgo = new Date(now.getTime() -  60 * 60 * 1000);
  const oneDayAgo  = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [perMinRow] = await db
    .select({ cnt: sql<number>`COUNT(*)` })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.fromWalletId, walletId), gte(transactionsTable.createdAt, oneMinAgo)));
  const txPerMin = Number(perMinRow?.cnt ?? 0);

  if (txPerMin >= limits.maxTxPerMinute) {
    throw new RateLimitExceededError("too many transfers", limits.maxTxPerMinute, txPerMin, "1 minute");
  }

  const [hourRow] = await db
    .select({ vol: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.fromWalletId, walletId), gte(transactionsTable.createdAt, oneHourAgo)));
  const hourlyVol = Number(hourRow?.vol ?? 0) + transferAmount;

  if (hourlyVol > limits.maxHourlyVolume) {
    throw new RateLimitExceededError("hourly volume exceeded", limits.maxHourlyVolume, hourlyVol, "1 hour");
  }

  const [dayRow] = await db
    .select({ vol: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.fromWalletId, walletId), gte(transactionsTable.createdAt, oneDayAgo)));
  const dailyVol = Number(dayRow?.vol ?? 0) + transferAmount;

  if (dailyVol > limits.maxDailyVolume) {
    throw new RateLimitExceededError("daily volume exceeded", limits.maxDailyVolume, dailyVol, "24 hours");
  }
}

export async function setWalletLimits(
  walletId: string,
  maxTxPerMinute: number,
  maxHourlyVolume: number,
  maxDailyVolume: number
): Promise<void> {
  await db
    .insert(walletLimitsTable)
    .values({ walletId, maxTxPerMinute, maxHourlyVolume: String(maxHourlyVolume), maxDailyVolume: String(maxDailyVolume) })
    .onConflictDoUpdate({
      target: walletLimitsTable.walletId,
      set: { maxTxPerMinute, maxHourlyVolume: String(maxHourlyVolume), maxDailyVolume: String(maxDailyVolume), updatedAt: new Date() },
    });
}
