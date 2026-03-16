import { db } from "@workspace/db";
import { fxLiquidityPoolsTable, fxLiquidityPositionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { generateId } from "./id";

const INITIAL_POOLS: Array<{ currency: string; poolSize: number; minThreshold: number }> = [
  { currency: "XOF", poolSize: 500_000_000, minThreshold: 50_000_000 },
  { currency: "XAF", poolSize: 500_000_000, minThreshold: 50_000_000 },
  { currency: "USD", poolSize: 10_000_000,  minThreshold: 500_000    },
  { currency: "EUR", poolSize: 10_000_000,  minThreshold: 500_000    },
  { currency: "GBP", poolSize: 5_000_000,   minThreshold: 250_000    },
  { currency: "GHS", poolSize: 50_000_000,  minThreshold: 5_000_000  },
];

export async function initLiquidityPools(): Promise<void> {
  for (const p of INITIAL_POOLS) {
    const existing = await db.select().from(fxLiquidityPoolsTable).where(eq(fxLiquidityPoolsTable.currency, p.currency)).limit(1);
    if (existing[0]) continue;
    const id       = generateId("fxlp");
    const available = p.poolSize * 0.85;
    const reserved  = p.poolSize * 0.15;
    const util      = (reserved / p.poolSize) * 100;
    await db.insert(fxLiquidityPoolsTable).values({
      id, currency: p.currency,
      poolSize:       String(p.poolSize),
      available:      String(available),
      reserved:       String(reserved),
      utilizationPct: String(util.toFixed(2)),
      minThreshold:   String(p.minThreshold),
    });
  }
}

export async function getAllPools() {
  return db.select().from(fxLiquidityPoolsTable);
}

export async function getPool(currency: string) {
  const rows = await db.select().from(fxLiquidityPoolsTable).where(eq(fxLiquidityPoolsTable.currency, currency)).limit(1);
  return rows[0] ?? null;
}

export interface SlippageResult {
  baseCurrency:   string;
  targetCurrency: string;
  amount:         number;
  slippageBps:    number;
  slippagePct:    number;
  effective:      boolean;
  availableLiq:   number;
}

export async function checkSlippage(
  baseCurrency:   string,
  targetCurrency: string,
  amount:         number
): Promise<SlippageResult> {
  const pool = await getPool(baseCurrency);
  const available = pool ? Number(pool.available) : 0;

  const utilizationRatio = available > 0 ? amount / available : 1;
  const slippageBps = Math.min(500, Math.round(utilizationRatio * 100 * 100));
  const slippagePct = slippageBps / 100;
  const effective   = amount <= available * 0.9;

  return { baseCurrency, targetCurrency, amount, slippageBps, slippagePct, effective, availableLiq: available };
}

export async function reserveLiquidity(
  baseCurrency:   string,
  targetCurrency: string,
  amount:         number
): Promise<string | null> {
  const pool = await getPool(baseCurrency);
  if (!pool) return null;

  const available = Number(pool.available);
  if (amount > available) return null;

  await db.update(fxLiquidityPoolsTable).set({
    available:      sql`${fxLiquidityPoolsTable.available} - ${String(amount)}`,
    reserved:       sql`${fxLiquidityPoolsTable.reserved} + ${String(amount)}`,
    utilizationPct: sql`ROUND((${fxLiquidityPoolsTable.reserved} + ${String(amount)}) / ${fxLiquidityPoolsTable.poolSize} * 100, 2)`,
    updatedAt:      new Date(),
  }).where(eq(fxLiquidityPoolsTable.id, pool.id));

  const slippage = await checkSlippage(baseCurrency, targetCurrency, amount);
  const posId    = generateId("fxpos");
  await db.insert(fxLiquidityPositionsTable).values({
    id:             posId,
    poolId:         pool.id,
    baseCurrency,
    targetCurrency,
    amount:         String(amount),
    slippageBps:    String(slippage.slippageBps),
    exposure:       String(amount),
    status:         "open",
  });
  return posId;
}

export async function getLiquidityStats() {
  const pools = await getAllPools();
  const totalPoolSize  = pools.reduce((s, p) => s + Number(p.poolSize),  0);
  const totalAvailable = pools.reduce((s, p) => s + Number(p.available), 0);
  const totalReserved  = pools.reduce((s, p) => s + Number(p.reserved),  0);
  const lowLiquidity   = pools.filter(p => Number(p.available) < Number(p.minThreshold));
  return {
    poolCount:    pools.length,
    totalPoolSize,
    totalAvailable,
    totalReserved,
    utilizationPct: totalPoolSize > 0 ? Number(((totalReserved / totalPoolSize) * 100).toFixed(2)) : 0,
    lowLiquidity:   lowLiquidity.map(p => ({ currency: p.currency, available: p.available, minThreshold: p.minThreshold })),
  };
}
