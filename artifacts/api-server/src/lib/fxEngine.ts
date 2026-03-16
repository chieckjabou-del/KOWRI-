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
      target: [exchangeRatesTable.baseCurrency, exchangeRatesTable.targetCurrency],
      set: { rate: String(rate), updatedAt: new Date() },
    });
}
