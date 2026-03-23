/**
 * KOWRI Fee Engine
 * ────────────────
 * Computes the fee for every outbound operation (cashout, merchant payment,
 * diaspora transfer, tontine payout, loan disbursement).
 *
 * INTERNAL TRANSFERS: always free — bypassed at the call site in processTransfer().
 * This is a deliberate architectural invariant, not a "no rule found = 0" fallback.
 *
 * Rule selection: most specific user tier wins over 'all'.
 * If no matching rule exists, fee is 0 (permissive default — log a warning).
 */

import { db } from "@workspace/db";
import { feeConfigTable, type FeeOperationType } from "@workspace/db";
import { eq, and, lte, gte, or, isNull, desc } from "drizzle-orm";
import { generateId } from "./id";

export type { FeeOperationType };

export interface FeeResult {
  feeAmount: number;
  netAmount: number;
  rateBps:   number;
}

// ── Core computation ──────────────────────────────────────────────────────────

export async function computeFee(
  operationType: FeeOperationType,
  amount:        number,
  userTier:      string = "bronze",
): Promise<FeeResult> {
  const amountStr = String(amount);

  const rules = await db
    .select()
    .from(feeConfigTable)
    .where(
      and(
        eq(feeConfigTable.operationType, operationType),
        eq(feeConfigTable.active, true),
        lte(feeConfigTable.minAmount, amountStr),
        or(
          isNull(feeConfigTable.maxAmount),
          gte(feeConfigTable.maxAmount, amountStr),
        ),
        or(
          eq(feeConfigTable.userTier, "all"),
          eq(feeConfigTable.userTier, userTier as "all" | "bronze" | "silver" | "gold" | "platinum"),
        ),
      ),
    )
    .orderBy(desc(feeConfigTable.userTier))
    .limit(1);

  if (!rules.length) {
    console.warn(`[FeeEngine] No rule for operationType=${operationType} amount=${amount} tier=${userTier} — defaulting to 0`);
    return { feeAmount: 0, netAmount: amount, rateBps: 0 };
  }

  const rule = rules[0];
  let feeAmount = Math.floor((amount * rule.feeRateBps) / 10_000);

  if (rule.feeMinAbs && Number(rule.feeMinAbs) > 0) {
    feeAmount = Math.max(feeAmount, Number(rule.feeMinAbs));
  }
  if (rule.feeMaxAbs && Number(rule.feeMaxAbs) > 0) {
    feeAmount = Math.min(feeAmount, Number(rule.feeMaxAbs));
  }

  return {
    feeAmount,
    netAmount: amount - feeAmount,
    rateBps:   rule.feeRateBps,
  };
}

// ── Default rule seed (idempotent) ────────────────────────────────────────────
// Internal transfers: ALWAYS 0 (enforced in processTransfer(), not here)
// Cash-out  < 50k XOF:       1.0% (100 bps)
// Cash-out  50k–200k XOF:    0.8%  (80 bps)
// Cash-out  > 200k XOF:      0.6%  (60 bps)
// Merchant payment:           0.5%  (50 bps)
// Diaspora transfer:          1.0% (100 bps)
// Tontine payout:             0.5%  (50 bps)
// Loan disbursement:          no default (0% until explicitly configured)

const DEFAULT_RULES = [
  {
    id: "fee-cashout-lt50k",
    operationType: "cashout"           as FeeOperationType,
    minAmount:     "0",
    maxAmount:     "49999.9999",
    feeRateBps:    100,
    feeMinAbs:     "0",
    feeMaxAbs:     null,
    userTier:      "all"              as const,
    active:        true,
  },
  {
    id: "fee-cashout-50k-200k",
    operationType: "cashout"           as FeeOperationType,
    minAmount:     "50000",
    maxAmount:     "200000",
    feeRateBps:    80,
    feeMinAbs:     "0",
    feeMaxAbs:     null,
    userTier:      "all"              as const,
    active:        true,
  },
  {
    id: "fee-cashout-gt200k",
    operationType: "cashout"           as FeeOperationType,
    minAmount:     "200000.0001",
    maxAmount:     null,
    feeRateBps:    60,
    feeMinAbs:     "0",
    feeMaxAbs:     null,
    userTier:      "all"              as const,
    active:        true,
  },
  {
    id: "fee-merchant",
    operationType: "merchant_payment"  as FeeOperationType,
    minAmount:     "0",
    maxAmount:     null,
    feeRateBps:    50,
    feeMinAbs:     "0",
    feeMaxAbs:     null,
    userTier:      "all"              as const,
    active:        true,
  },
  {
    id: "fee-diaspora",
    operationType: "diaspora_transfer" as FeeOperationType,
    minAmount:     "0",
    maxAmount:     null,
    feeRateBps:    100,
    feeMinAbs:     "0",
    feeMaxAbs:     null,
    userTier:      "all"              as const,
    active:        true,
  },
  {
    id: "fee-tontine",
    operationType: "tontine_payout"    as FeeOperationType,
    minAmount:     "0",
    maxAmount:     null,
    feeRateBps:    50,
    feeMinAbs:     "0",
    feeMaxAbs:     null,
    userTier:      "all"              as const,
    active:        true,
  },
] as const;

export async function seedFeeConfig(): Promise<void> {
  const existing = await db
    .select({ id: feeConfigTable.id })
    .from(feeConfigTable)
    .limit(1);

  if (existing.length > 0) return; // Already seeded — idempotent

  await db.insert(feeConfigTable).values(DEFAULT_RULES.map(r => ({ ...r })));
  console.log(`[FeeEngine] Seeded ${DEFAULT_RULES.length} default fee rules`);
}
