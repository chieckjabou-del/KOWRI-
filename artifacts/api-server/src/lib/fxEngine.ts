import { db } from "@workspace/db";
import { exchangeRatesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export class FXNotFoundError extends Error {
  constructor(from: string, to: string) {
    super(`No exchange rate found for ${from} → ${to}`);
    this.name = "FXNotFoundError";
  }
}

export async function getRate(baseCurrency: string, targetCurrency: string): Promise<number> {
  if (baseCurrency === targetCurrency) return 1;

  const [row] = await db
    .select()
    .from(exchangeRatesTable)
    .where(and(eq(exchangeRatesTable.baseCurrency, baseCurrency), eq(exchangeRatesTable.targetCurrency, targetCurrency)));

  if (!row) throw new FXNotFoundError(baseCurrency, targetCurrency);
  return Number(row.rate);
}

// Conversions are rounded DOWN to the stored scale (4 decimals). Rounding half-up
// would let a caller gain up to half a unit on every conversion and turn a
// round trip through a pair into a repeatable profit against the FX book.
export function floorToScale(value: number): number {
  return Math.floor(value * 10000 + 1e-9) / 10000;
}

export async function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string
): Promise<{ convertedAmount: number; rate: number }> {
  const rate = await getRate(fromCurrency, toCurrency);
  await assertNoArbitrage(fromCurrency, toCurrency, rate);
  const convertedAmount = floorToScale(amount * rate);
  return { convertedAmount, rate };
}

// A pair is consistent when converting there and back cannot return more than
// the starting amount: rate(A→B) × rate(B→A) ≤ 1. Publishing a rate that breaks
// this (as the original seed did for USD/XOF: 610 × 0.00164 = 1.0004) lets any
// user with two wallets mint money out of the platform's FX account.
export class FxArbitrageError extends Error {
  constructor(from: string, to: string, product: number) {
    super(`Rates ${from}→${to} and ${to}→${from} multiply to ${product.toFixed(6)} (> 1): a round trip would create money`);
    this.name = "FxArbitrageError";
  }
}

export async function assertNoArbitrage(from: string, to: string, rate: number): Promise<void> {
  if (from === to) return;
  const [inverse] = await db
    .select({ rate: exchangeRatesTable.rate })
    .from(exchangeRatesTable)
    .where(and(eq(exchangeRatesTable.baseCurrency, to), eq(exchangeRatesTable.targetCurrency, from)));
  if (!inverse) return;
  const product = rate * Number(inverse.rate);
  if (product > 1 + 1e-9) throw new FxArbitrageError(from, to, product);
}

// Lists every published pair whose inverse would allow a profitable round trip.
export async function findArbitragePairs(): Promise<Array<{ from: string; to: string; product: number }>> {
  const rows = await getAllRates();
  const byPair = new Map(rows.map((r) => [`${r.baseCurrency}→${r.targetCurrency}`, r.rate]));
  const bad: Array<{ from: string; to: string; product: number }> = [];
  for (const r of rows) {
    const inverse = byPair.get(`${r.targetCurrency}→${r.baseCurrency}`);
    if (inverse === undefined || r.baseCurrency > r.targetCurrency) continue;
    const product = r.rate * inverse;
    if (product > 1 + 1e-9) bad.push({ from: r.baseCurrency, to: r.targetCurrency, product });
  }
  return bad;
}

// Platform limits (KYC ceilings, velocity caps) are expressed in XOF. Every
// amount in another currency is converted at the published rate before being
// compared; a currency with no published rate cannot be evaluated, so the
// caller must refuse rather than silently apply the XOF figure.
export const REFERENCE_CURRENCY = "XOF";

export async function toReferenceCurrency(amount: number, currency: string): Promise<number> {
  const cur = currency.toUpperCase();
  if (cur === REFERENCE_CURRENCY) return amount;
  try {
    return amount * (await getRate(cur, REFERENCE_CURRENCY));
  } catch (err) {
    if (!(err instanceof FXNotFoundError)) throw err;
  }
  try {
    return amount / (await getRate(REFERENCE_CURRENCY, cur));
  } catch (err) {
    if (!(err instanceof FXNotFoundError)) throw err;
  }
  throw new Error(`Taux de change indisponible pour ${cur} : limite non évaluable`);
}

export async function getAllRates(): Promise<
  Array<{ baseCurrency: string; targetCurrency: string; rate: number; updatedAt: Date }>
> {
  const rows = await db.select().from(exchangeRatesTable);
  return rows.map((r) => ({
    baseCurrency: r.baseCurrency,
    targetCurrency: r.targetCurrency,
    rate: Number(r.rate),
    updatedAt: r.updatedAt,
  }));
}

// Reference rates for every corridor the platform serves, loaded once on an empty table.
// Operators are expected to keep them current through PUT /fx/rates.
const SEED_RATES: Array<[string, string, number]> = [
  ["EUR", "XOF", 655.957], ["XOF", "EUR", 1 / 655.957],
  ["EUR", "XAF", 655.957], ["XAF", "EUR", 1 / 655.957],
  ["USD", "XOF", 610],     ["XOF", "USD", 1 / 610],
  ["USD", "XAF", 610],     ["XAF", "USD", 1 / 610],
  ["GBP", "XOF", 770],     ["XOF", "GBP", 1 / 770],
  ["XOF", "XAF", 1],       ["XAF", "XOF", 1],
  ["XOF", "GHS", 0.012],   ["GHS", "XOF", 1 / 0.012],
  ["GBP", "GHS", 19.5],    ["GHS", "GBP", 1 / 19.5],
  ["USD", "NGN", 1500],    ["NGN", "USD", 1 / 1500],
  ["USD", "KES", 129],     ["KES", "USD", 1 / 129],
  ["XOF", "NGN", 2.45],    ["NGN", "XOF", 1 / 2.45],
  ["USD", "EUR", 0.93],    ["EUR", "USD", 1 / 0.93],
];

export async function seedExchangeRates(): Promise<number> {
  const existing = new Set((await db.select({ id: exchangeRatesTable.id }).from(exchangeRatesTable)).map((r) => r.id));
  let seeded = 0;
  for (const [from, to, rate] of SEED_RATES) {
    const id = `fx-${from.toLowerCase()}-${to.toLowerCase()}`;
    if (existing.has(id)) continue;
    // Rounded DOWN to the stored scale so an inverse pair never multiplies above 1.
    await upsertRate(id, from, to, Math.floor(rate * 1e8) / 1e8);
    seeded += 1;
  }
  if (seeded > 0) console.log(`[FX] Seeded ${seeded} missing reference exchange rates`);
  return seeded;
}

export async function upsertRate(
  id: string,
  baseCurrency: string,
  targetCurrency: string,
  rate: number
): Promise<void> {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Invalid FX rate: ${rate}`);
  await assertNoArbitrage(baseCurrency, targetCurrency, rate);
  await db
    .insert(exchangeRatesTable)
    .values({ id, baseCurrency, targetCurrency, rate: String(rate), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: exchangeRatesTable.id,
      set: { rate: String(rate), updatedAt: new Date() },
    });
}
