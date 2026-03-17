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

interface CacheEntry { data: WalletLimits; expiresAt: number; }
const limitsCache = new Map<string, CacheEntry>();
const LIMITS_TTL_MS = 60_000;

function evictStaleEntries(): void {
  const now = Date.now();
  for (const [k, v] of limitsCache) {
    if (now >= v.expiresAt) limitsCache.delete(k);
  }
}
setInterval(evictStaleEntries, LIMITS_TTL_MS).unref();

async function getLimits(walletId: string): Promise<WalletLimits> {
  const cached = limitsCache.get(walletId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const [row] = await db.select().from(walletLimitsTable).where(eq(walletLimitsTable.walletId, walletId));
  const limits: WalletLimits = !row ? DEFAULTS : {
    maxTxPerMinute:  row.maxTxPerMinute,
    maxHourlyVolume: Number(row.maxHourlyVolume),
    maxDailyVolume:  Number(row.maxDailyVolume),
  };

  limitsCache.set(walletId, { data: limits, expiresAt: Date.now() + LIMITS_TTL_MS });
  return limits;
}

export function invalidateLimitsCache(walletId: string): void {
  limitsCache.delete(walletId);
}

interface SlidingWindowEntry { count: number; volumeSum: number; windowStart: number; }
const inMemoryCounters = new Map<string, SlidingWindowEntry>();
const COUNTER_WINDOW_MS = 60_000;

function getInMemoryCount(walletId: string): SlidingWindowEntry {
  const now = Date.now();
  const existing = inMemoryCounters.get(walletId);
  if (!existing || now - existing.windowStart > COUNTER_WINDOW_MS) {
    const entry: SlidingWindowEntry = { count: 0, volumeSum: 0, windowStart: now };
    inMemoryCounters.set(walletId, entry);
    return entry;
  }
  return existing;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of inMemoryCounters) {
    if (now - v.windowStart > COUNTER_WINDOW_MS * 2) inMemoryCounters.delete(k);
  }
}, COUNTER_WINDOW_MS).unref();

export async function checkRateLimit(walletId: string, transferAmount: number): Promise<void> {
  const limits = await getLimits(walletId);

  const counter = getInMemoryCount(walletId);
  if (counter.count >= limits.maxTxPerMinute) {
    throw new RateLimitExceededError("too many transfers", limits.maxTxPerMinute, counter.count, "1 minute");
  }

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

  counter.count++;
  counter.volumeSum += transferAmount;
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
  invalidateLimitsCache(walletId);
}
