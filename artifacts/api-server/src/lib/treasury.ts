// ── Platform treasury ────────────────────────────────────────────────────────
// The platform's own money lives in ordinary wallets owned by a system user, so
// every loan disbursement and repayment is a real double-entry transfer between
// the borrower and the treasury instead of money appearing from nowhere and
// repayments going nowhere.
//
// Outside production the XOF treasury is seeded once with an initial float so
// loans work on a fresh database; in production operations fund it through the
// platform cash-in route (`POST /wallets/:id/deposit`, permission ledger.write).

import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { usersTable, walletsTable, transactionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { generateId } from "./id";
import { hashPin } from "./pin";
import { processDeposit, getWalletBalance } from "./walletService";

export const TREASURY_USER_ID = "kowri_treasury";
const TREASURY_PHONE = "+000000000000";
const SEED_FLOAT: Record<string, number> = { XOF: 100_000_000, XAF: 100_000_000 };

export async function ensureTreasuryUser(): Promise<void> {
  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, TREASURY_USER_ID)).limit(1);
  if (existing) return;
  await db.insert(usersTable).values({
    id: TREASURY_USER_ID,
    phone: TREASURY_PHONE,
    firstName: "KOWRI",
    lastName: "Treasury",
    country: "SN",
    status: "active",
    kycLevel: 3,
    // No one logs in as the treasury: the PIN is a random 64-hex secret nobody knows.
    pinHash: hashPin(randomBytes(32).toString("hex")),
  }).onConflictDoNothing();
}

export async function getTreasuryWallet(currency: string): Promise<typeof walletsTable.$inferSelect> {
  const cur = currency.toUpperCase();
  const [wallet] = await db.select().from(walletsTable)
    .where(and(eq(walletsTable.userId, TREASURY_USER_ID), eq(walletsTable.currency, cur), eq(walletsTable.status, "active")))
    .limit(1);
  if (wallet) return wallet;
  await ensureTreasuryUser();
  const [created] = await db.insert(walletsTable).values({
    id: generateId(),
    userId: TREASURY_USER_ID,
    currency: cur,
    walletType: "personal",
    balance: "0",
    availableBalance: "0",
    status: "active",
  }).returning();
  return created;
}

export async function listTreasuryWallets(): Promise<Array<{ id: string; currency: string; status: string; balance: number }>> {
  const wallets = await db.select().from(walletsTable).where(eq(walletsTable.userId, TREASURY_USER_ID));
  return Promise.all(wallets.map(async (w) => ({ id: w.id, currency: w.currency, status: w.status, balance: await getWalletBalance(w.id) })));
}

// Development / test convenience only: never runs in production.
export async function seedTreasuryFloat(): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  await ensureTreasuryUser();
  for (const [currency, amount] of Object.entries(SEED_FLOAT)) {
    const reference = `TREASURY-SEED-${currency}`;
    const [done] = await db.select({ id: transactionsTable.id }).from(transactionsTable).where(eq(transactionsTable.reference, reference)).limit(1);
    if (done) continue;
    const wallet = await getTreasuryWallet(currency);
    await processDeposit({
      walletId: wallet.id, amount, currency, reference,
      description: "Initial platform capital (non-production seed)",
      idempotencyKey: `treasury-seed:${currency}`, internal: true,
      authority: { kind: "treasury_seed" },
    });
    console.log(`[Treasury] seeded ${amount.toLocaleString("fr-FR")} ${currency} into ${wallet.id}`);
  }
}
