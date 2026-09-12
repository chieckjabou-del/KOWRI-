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

export async function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string
): Promise<{ convertedAmount: number; rate: number }> {
  const rate = await getRate(fromCurrency, toCurrency);
  const convertedAmount = Math.round(amount * rate * 10000) / 10000;
  return { convertedAmount, rate };
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
  ["USD", "XOF", 610],     ["XOF", "USD", 0.00164],
  ["USD", "XAF", 610],     ["XAF", "USD", 0.00164],
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
    await upsertRate(id, from, to, Number(rate.toFixed(8)));
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
  await db
    .insert(exchangeRatesTable)
    .values({ id, baseCurrency, targetCurrency, rate: String(rate), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: exchangeRatesTable.id,
      set: { rate: String(rate), updatedAt: new Date() },
    });
}
