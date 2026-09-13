import { db } from "@workspace/db";
import { ledgerEntriesTable, walletsTable, transactionsTable, usersTable } from "@workspace/db";
import { eq, sql, and, gte, inArray } from "drizzle-orm";
import { generateId, generateReference } from "./id";
import { assertValidTransition } from "./stateMachine";
import { audit } from "./auditLogger";
import { eventBus } from "./eventBus";
import { recordMetric } from "./metrics";
import { checkRateLimit, RateLimitExceededError } from "./rateLimiter";
import { assertTransactionAllowed } from "./riskScreening";
import { guard } from "./killSwitch";
import { computeFee } from "./feeEngine";
import { toReferenceCurrency, REFERENCE_CURRENCY } from "./fxEngine";

// Every ledger transaction is retried on deadlock/serialization failure; the
// callback only contains writes that are rolled back with the transaction, so a
// retry never double-posts.
const runTx: typeof db.transaction = ((fn: Parameters<typeof db.transaction>[0], cfg?: Parameters<typeof db.transaction>[1]) =>
  withDeadlockRetry(() => db.transaction(fn, cfg))) as typeof db.transaction;

export type DbClient = typeof db;

// Domain writes that must land in the same database transaction as the ledger
// movement (a loan repayment row, a pool position, a claim status). The hook
// runs after the entries are posted and the balances synced; anything it throws
// rolls the money movement back with it, so no caller can end up with money
// moved on one side and its business record missing on the other.
export type AttachedWrite = (tx: DbClient) => Promise<void>;

// numeric(20,4): 16 integer digits. Anything above this cannot be stored and
// would surface as a database error instead of a clean refusal.
export const MAX_AMOUNT = 1_000_000_000_000_000; // 10^15
const AMOUNT_SCALE = 10_000;

// Amounts are stored with four decimals. A caller sending 0.00001 would create a
// transaction whose entries are all zero; a caller sending 1e17 would overflow
// the column. Both are refused here, and every amount is rounded to the stored
// scale before it is compared with a balance so the check and the posting agree.
export function normalizeAmount(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) throw new InvalidAmountError(amount);
  const rounded = Math.round(amount * AMOUNT_SCALE) / AMOUNT_SCALE;
  if (rounded <= 0) throw new InvalidAmountError(`${amount} (below the smallest storable unit)`);
  if (rounded > MAX_AMOUNT) throw new InvalidAmountError(`${amount} (above the maximum of ${MAX_AMOUNT})`);
  return rounded;
}

export class CurrencyMismatchError extends Error {
  constructor(walletId: string, expected: string, received: string) {
    super(`Wallet ${walletId} is denominated in ${expected}, got ${received}`);
    this.name = "CurrencyMismatchError";
  }
}

export class InvalidAmountError extends Error {
  constructor(amount: unknown) {
    super(`Invalid amount: ${String(amount)}`);
    this.name = "InvalidAmountError";
  }
}

// A fee rule that would take more than the amount itself (or a negative fee)
// can never be posted: the net leg would be a negative credit.
export class InvalidFeeError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidFeeError"; }
}

export class WalletUnavailableError extends Error {
  constructor(walletId: string, status: string, direction: "debit" | "credit") {
    super(`Wallet ${walletId} is ${status} and cannot be ${direction === "debit" ? "debited" : "credited"}`);
    this.name = "WalletUnavailableError";
  }
}

interface LockedWallet { currency: string; status: string }

// Serialises every operation on one business entity (a loan, a tontine, a pool)
// inside the calling transaction: the lock is released when the transaction
// ends, so a crashed instance never leaves it behind.
export async function lockEntity(tx: DbClient, scope: string, id: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${scope}:${id}`}))`);
}

// Balance is only meaningful in the wallet's own currency; entries in any other
// currency are excluded so a foreign-currency posting can never inflate it.
async function ledgerBalance(client: DbClient, walletId: string, currency: string): Promise<number> {
  const [result] = await client
    .select({
      balance: sql<number>`
        COALESCE(SUM(CAST(${ledgerEntriesTable.creditAmount} AS NUMERIC)), 0) -
        COALESCE(SUM(CAST(${ledgerEntriesTable.debitAmount} AS NUMERIC)), 0)
      `,
    })
    .from(ledgerEntriesTable)
    .where(and(
      eq(ledgerEntriesTable.accountId, walletId),
      eq(ledgerEntriesTable.accountType, "wallet"),
      eq(ledgerEntriesTable.currency, currency),
    ));
  return Number(result?.balance ?? 0);
}

async function lockWallets(tx: DbClient, walletIds: string[]): Promise<Map<string, LockedWallet>> {
  const ids = [...new Set(walletIds)].sort();
  const placeholders = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const result = await tx.execute(
    sql`SELECT id, currency, status FROM wallets WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`
  );
  const rows = ((result as any).rows ?? []) as Array<{ id: string; currency: string; status: string }>;
  const map = new Map<string, LockedWallet>();
  for (const row of rows) map.set(row.id, { currency: row.currency, status: row.status });
  return map;
}

// A frozen wallet can still receive funds but never release them; a closed wallet does neither.
function assertWalletUsable(wallets: Map<string, LockedWallet>, walletId: string, currency: string, direction: "debit" | "credit"): void {
  const wallet = wallets.get(walletId);
  if (!wallet) throw new Error(`Wallet ${walletId} not found`);
  if (wallet.currency !== currency) throw new CurrencyMismatchError(walletId, wallet.currency, currency);
  if (wallet.status === "closed" || (wallet.status === "frozen" && direction === "debit")) {
    throw new WalletUnavailableError(walletId, wallet.status, direction);
  }
}

export async function getWalletBalance(walletId: string): Promise<number> {
  const [wallet] = await db.select({ currency: walletsTable.currency }).from(walletsTable).where(eq(walletsTable.id, walletId)).limit(1);
  if (!wallet) return 0;
  return ledgerBalance(db, walletId, wallet.currency);
}

export async function syncWalletBalance(
  walletId: string,
  txClient?: DbClient
): Promise<number> {
  const client = txClient ?? db;
  const [wallet] = await client.select({ currency: walletsTable.currency }).from(walletsTable).where(eq(walletsTable.id, walletId)).limit(1);
  if (!wallet) throw new Error(`Wallet ${walletId} not found`);

  const derived = await ledgerBalance(client, walletId, wallet.currency);

  await client
    .update(walletsTable)
    .set({ balance: String(derived), availableBalance: String(derived), updatedAt: new Date() })
    .where(eq(walletsTable.id, walletId));

  return derived;
}

export async function reconcileAllWallets(): Promise<
  Array<{ walletId: string; stored: number; derived: number; mismatch: boolean }>
> {
  const wallets = await db.select().from(walletsTable);
  const report = [];
  for (const w of wallets) {
    const derived = await ledgerBalance(db, w.id, w.currency);
    const stored = Number(w.balance);
    const mismatch = Math.abs(stored - derived) > 0.01;
    report.push({ walletId: w.id, stored, derived, mismatch });
  }
  return report;
}

export async function processDeposit(params: {
  walletId: string;
  amount: number;
  currency: string;
  reference: string;
  description?: string;
  idempotencyKey?: string;
  internal?: boolean;
  attach?: AttachedWrite;
}): Promise<typeof transactionsTable.$inferSelect> {
  const { walletId, currency, reference, description, idempotencyKey, internal, attach } = params;
  const amount = normalizeAmount(params.amount);
  guard("all");
  const start = Date.now();
  const txId = generateId();
  const now = new Date();

  await assertTransactionAllowed({ walletId, transactionId: txId, amount, currency, kind: "deposit", internal });

  let newBalanceAfterDeposit: number | undefined;

  await runTx(async (tx) => {
    const locked = await lockWallets(tx as any, [walletId]);
    assertWalletUsable(locked, walletId, currency, "credit");

    assertValidTransition("pending", "processing");

    await tx.insert(transactionsTable).values({
      id: txId,
      toWalletId: walletId,
      amount: String(amount),
      currency,
      type: "deposit",
      status: "processing",
      reference,
      description: description ?? "Deposit",
      idempotencyKey: idempotencyKey ?? null,
    });

    assertValidTransition("processing", "completed");

    const ledgerStart = Date.now();

    await tx.insert(ledgerEntriesTable).values([
      {
        id: generateId(),
        transactionId: txId,
        accountId: "platform_float",
        accountType: "platform",
        debitAmount: String(amount),
        creditAmount: "0",
        currency,
        eventType: "deposit",
        description: "Platform float debit",
        entryType: "debit",
        walletId: null,
        reference,
      },
      {
        id: generateId(),
        transactionId: txId,
        accountId: walletId,
        accountType: "wallet",
        debitAmount: "0",
        creditAmount: String(amount),
        currency,
        eventType: "deposit",
        description: "Wallet credit",
        entryType: "credit",
        walletId,
        reference,
      },
    ]);

    recordMetric("ledger", Date.now() - ledgerStart);

    const newBalance = await syncWalletBalance(walletId, tx as any);
    newBalanceAfterDeposit = newBalance;

    if (attach) await attach(tx as any);

    await tx
      .update(transactionsTable)
      .set({ status: "completed", completedAt: now })
      .where(eq(transactionsTable.id, txId));
  });

  const [finalTx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, txId));
  const newBalance = newBalanceAfterDeposit;

  await Promise.all([
    audit({ action: "transaction.created", entity: "transaction", entityId: txId, metadata: { type: "deposit", amount, currency, walletId } }),
    audit({ action: "ledger.entry_written", entity: "wallet", entityId: walletId, metadata: { txId, amount, newBalance } }),
    eventBus.publish("transaction.created", { txId, type: "deposit", amount, currency, walletId }),
    eventBus.publish("wallet.balance.updated", { walletId, newBalance, currency }),
  ]);

  recordMetric("transaction", Date.now() - start, "deposit");
  return finalTx;
}

const KYC_MONTHLY_LIMITS: Record<number, number> = {
  0: 100_000,
  1: 1_000_000,
  2: 10_000_000,
};

export async function getMonthlyVolume(fromWalletId: string, client: DbClient = db): Promise<number> {
  // Calendar month in UTC so every instance and every user sees the same window.
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // Every outgoing type counts toward the cap, so cash-out cannot sidestep the transfer limit.
  // Amounts are summed per currency and converted to the reference currency (XOF).
  const rows = await client
    .select({ currency: transactionsTable.currency, total: sql<number>`COALESCE(SUM(CAST(${transactionsTable.amount} AS NUMERIC)), 0)` })
    .from(transactionsTable)
    .where(and(
      eq(transactionsTable.fromWalletId, fromWalletId),
      inArray(transactionsTable.type, ["transfer", "withdrawal", "merchant_payment"]),
      inArray(transactionsTable.status, ["processing", "completed"]),
      gte(transactionsTable.createdAt, startOfMonth),
    ))
    .groupBy(transactionsTable.currency);
  let total = 0;
  for (const r of rows) total += await toReferenceCurrency(Number(r.total ?? 0), r.currency);
  return total;
}

// Raised when a debit would push the wallet's monthly outgoing volume past its KYC ceiling.
export class KycLimitError extends Error {
  constructor(message: string) { super(message); this.name = "KycLimitError"; }
}

// KYC ceilings are XOF figures; the amount is converted at the published rate so a
// EUR or USD wallet is capped at the same real value as a XOF wallet.
//
// Called INSIDE the ledger transaction, after the source wallet row is locked:
// concurrent debits from one wallet are serialised by that lock, so the volume
// read here already includes every earlier debit and the ceiling cannot be
// exceeded by firing requests in parallel.
async function enforceKycLimit(client: DbClient, fromWalletId: string, amount: number, currency: string): Promise<void> {
  const [wallet] = await client
    .select({ userId: walletsTable.userId })
    .from(walletsTable)
    .where(eq(walletsTable.id, fromWalletId))
    .limit(1);
  if (!wallet) return;

  const [user] = await client
    .select({ kycLevel: usersTable.kycLevel })
    .from(usersTable)
    .where(eq(usersTable.id, wallet.userId))
    .limit(1);

  const kycLevel = user?.kycLevel ?? 0;
  const monthlyLimit = KYC_MONTHLY_LIMITS[kycLevel] ?? KYC_MONTHLY_LIMITS[0];
  const monthlyVolume = await getMonthlyVolume(fromWalletId, client);
  const referenceAmount = await toReferenceCurrency(amount, currency);

  if (monthlyVolume + referenceAmount > monthlyLimit) {
    throw new KycLimitError(
      `Limite mensuelle atteinte (${monthlyLimit.toLocaleString("fr-FR")} ${REFERENCE_CURRENCY}` +
      `${currency.toUpperCase() !== REFERENCE_CURRENCY ? ` ou équivalent en ${currency.toUpperCase()}` : ""}). ` +
      `Complétez votre KYC pour augmenter votre plafond.`
    );
  }
}

export async function processTransfer(params: {
  fromWalletId: string;
  toWalletId: string;
  amount: number;
  currency: string;
  description?: string;
  reference?: string;
  idempotencyKey?: string;
  skipRateLimitCheck?: boolean;
  skipFraudCheck?: boolean;
  skipKycCheck?: boolean;
  attach?: AttachedWrite;
}): Promise<typeof transactionsTable.$inferSelect> {
  const { fromWalletId, toWalletId, currency, description, reference, idempotencyKey, skipRateLimitCheck, skipFraudCheck, skipKycCheck, attach } = params;
  const amount = normalizeAmount(params.amount);
  if (fromWalletId === toWalletId) throw new Error("Cannot transfer to the same wallet");
  const start = Date.now();

  // ── INTERNAL TRANSFERS ARE ALWAYS FREE ────────────────────────────────────
  // Fee engine is explicitly bypassed for wallet-to-wallet (P2P) transfers.
  // This is a deliberate architectural invariant — not a "no rule found = 0"
  // fallback. Any fee on internal transfers would be economically incorrect and
  // must NEVER be introduced via fee_config rules.
  // ──────────────────────────────────────────────────────────────────────────

  guard("outbound_transfers");   // throws KillSwitchError if switch is TRIGGERED or FORCED_OFF

  const txId = generateId();
  const ref = reference ?? generateReference();
  const now = new Date();

  // Screening runs before any lock or write: a blocked transfer never touches the ledger.
  await assertTransactionAllowed({ walletId: fromWalletId, transactionId: txId, amount, currency, kind: "transfer", internal: skipFraudCheck });

  await runTx(async (tx) => {
    const locked = await lockWallets(tx as any, [fromWalletId, toWalletId]);
    assertWalletUsable(locked, fromWalletId, currency, "debit");
    assertWalletUsable(locked, toWalletId, currency, "credit");

    // Limits are evaluated under the source wallet lock (see enforceKycLimit).
    if (!skipKycCheck) await enforceKycLimit(tx as any, fromWalletId, amount, currency);
    if (!skipRateLimitCheck) await checkRateLimit(fromWalletId, amount, currency, tx as any);

    const availableBal = await ledgerBalance(tx as any, fromWalletId, currency);
    if (availableBal < amount) throw new Error("Insufficient funds");

    assertValidTransition("pending", "processing");

    await tx.insert(transactionsTable).values({
      id: txId,
      fromWalletId,
      toWalletId,
      amount: String(amount),
      currency,
      type: "transfer",
      status: "processing",
      reference: ref,
      description: description ?? "P2P Transfer",
      idempotencyKey: idempotencyKey ?? null,
    });

    assertValidTransition("processing", "completed");

    const ledgerStart = Date.now();
    await tx.insert(ledgerEntriesTable).values([
      {
        id: generateId(),
        transactionId: txId,
        accountId: fromWalletId,
        accountType: "wallet",
        debitAmount: String(amount),
        creditAmount: "0",
        currency,
        eventType: "transfer",
        description: "Transfer debit",
        entryType: "debit",
        walletId: fromWalletId,
        reference: ref,
      },
      {
        id: generateId(),
        transactionId: txId,
        accountId: toWalletId,
        accountType: "wallet",
        debitAmount: "0",
        creditAmount: String(amount),
        currency,
        eventType: "transfer",
        description: "Transfer credit",
        entryType: "credit",
        walletId: toWalletId,
        reference: ref,
      },
    ]);
    recordMetric("ledger", Date.now() - ledgerStart);

    await Promise.all([
      syncWalletBalance(fromWalletId, tx as any),
      syncWalletBalance(toWalletId, tx as any),
    ]);

    if (attach) await attach(tx as any);

    await tx
      .update(transactionsTable)
      .set({ status: "completed", completedAt: now })
      .where(eq(transactionsTable.id, txId));
  });

  const [finalTx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, txId));

  await Promise.all([
    audit({ action: "transaction.created", entity: "transaction", entityId: txId, metadata: { type: "transfer", amount, currency, fromWalletId, toWalletId } }),
    audit({ action: "ledger.entry_written", entity: "wallet", entityId: fromWalletId, metadata: { txId, role: "debit" } }),
    audit({ action: "ledger.entry_written", entity: "wallet", entityId: toWalletId, metadata: { txId, role: "credit" } }),
    eventBus.publish("transaction.created", { txId, type: "transfer", amount, currency, fromWalletId, toWalletId }),
    eventBus.publish("wallet.balance.updated", { walletId: fromWalletId, currency }),
    eventBus.publish("wallet.balance.updated", { walletId: toWalletId, currency }),
  ]);

  recordMetric("transaction", Date.now() - start, "transfer");
  return finalTx;
}

// ── processFxTransfer (cross-currency, fee-bearing) ───────────────────────────
// Used for remittances. Each currency leg balances independently:
//   fromCurrency: DEBIT sender (amount+fee) | CREDIT platform_fees (fee) | CREDIT platform_fx (amount)
//   toCurrency:   DEBIT platform_fx (converted) | CREDIT recipient (converted)
export async function processFxTransfer(params: {
  fromWalletId: string;
  toWalletId: string;
  amount: number;
  fee: number;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  description?: string;
  reference?: string;
  idempotencyKey?: string;
  skipKycCheck?: boolean;
  skipRateLimitCheck?: boolean;
  attach?: AttachedWrite;
}): Promise<{ transaction: typeof transactionsTable.$inferSelect; amountReceived: number; totalDebit: number }> {
  const { fromWalletId, toWalletId, fromCurrency, toCurrency, rate, description, idempotencyKey, attach } = params;
  const amount = normalizeAmount(params.amount);
  const fee = params.fee === 0 ? 0 : normalizeAmount(params.fee);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Invalid FX rate: ${rate}`);
  if (fromWalletId === toWalletId) throw new Error("Cannot transfer to the same wallet");

  guard("outbound_transfers");

  const totalDebit = Math.round((amount + fee) * 10000) / 10000;
  // The target leg is rounded DOWN to the stored scale: the platform's FX book
  // never pays out more than the exact conversion, so a round trip through any
  // pair can at best return the starting amount, never more (see fxEngine).
  const amountReceived = Math.floor(amount * rate * 10000 + 1e-9) / 10000;
  if (amountReceived <= 0) throw new InvalidAmountError(`${amount} ${fromCurrency} converts to less than one unit of ${toCurrency}`);
  const txId = generateId();
  const ref = params.reference ?? generateReference();
  const now = new Date();
  const start = Date.now();

  await assertTransactionAllowed({ walletId: fromWalletId, transactionId: txId, amount, currency: fromCurrency, kind: "fx_transfer" });

  await runTx(async (tx) => {
    const locked = await lockWallets(tx as any, [fromWalletId, toWalletId]);
    assertWalletUsable(locked, fromWalletId, fromCurrency, "debit");
    assertWalletUsable(locked, toWalletId, toCurrency, "credit");

    if (!params.skipKycCheck) await enforceKycLimit(tx as any, fromWalletId, amount, fromCurrency);
    if (!params.skipRateLimitCheck) await checkRateLimit(fromWalletId, amount, fromCurrency, tx as any);

    const availableBal = await ledgerBalance(tx as any, fromWalletId, fromCurrency);
    if (availableBal < totalDebit) throw new Error("Insufficient funds");

    await tx.insert(transactionsTable).values({
      id: txId,
      fromWalletId,
      toWalletId,
      amount: String(amount),
      currency: fromCurrency,
      type: "transfer",
      status: "processing",
      reference: ref,
      description: description ?? "Cross-currency transfer",
      idempotencyKey: idempotencyKey ?? null,
      metadata: { fee, rate, toCurrency, amountReceived, totalDebit },
    });

    const base = { transactionId: txId, reference: ref, eventType: "fx_transfer" };
    await tx.insert(ledgerEntriesTable).values([
      { id: generateId(), ...base, accountId: fromWalletId, accountType: "wallet", debitAmount: String(totalDebit), creditAmount: "0", currency: fromCurrency, description: "Remittance debit (amount + fee)", entryType: "debit", walletId: fromWalletId },
      // The fee leg only exists when a fee applies (the ledger refuses empty entries).
      ...(fee > 0 ? [{ id: generateId(), ...base, accountId: "platform_fees", accountType: "platform", debitAmount: "0", creditAmount: String(fee), currency: fromCurrency, description: "Remittance fee", entryType: "credit", walletId: null }] : []),
      { id: generateId(), ...base, accountId: "platform_fx", accountType: "platform", debitAmount: "0", creditAmount: String(amount), currency: fromCurrency, description: "FX source leg", entryType: "credit", walletId: null },
      { id: generateId(), ...base, accountId: "platform_fx", accountType: "platform", debitAmount: String(amountReceived), creditAmount: "0", currency: toCurrency, description: `FX target leg @ ${rate}`, entryType: "debit", walletId: null },
      { id: generateId(), ...base, accountId: toWalletId, accountType: "wallet", debitAmount: "0", creditAmount: String(amountReceived), currency: toCurrency, description: "Remittance credit", entryType: "credit", walletId: toWalletId },
    ]);

    await Promise.all([
      syncWalletBalance(fromWalletId, tx as any),
      syncWalletBalance(toWalletId, tx as any),
    ]);

    if (attach) await attach(tx as any);

    await tx.update(transactionsTable).set({ status: "completed", completedAt: now }).where(eq(transactionsTable.id, txId));
  });

  const [finalTx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, txId));

  await Promise.all([
    audit({ action: "transaction.created", entity: "transaction", entityId: txId, metadata: { type: "fx_transfer", amount, fee, rate, fromCurrency, toCurrency, amountReceived, fromWalletId, toWalletId } }),
    audit({ action: "fee.applied", entity: "transaction", entityId: txId, metadata: { feeAmount: fee, operationType: "diaspora_transfer" } }),
    eventBus.publish("transaction.created", { txId, type: "transfer", amount, currency: fromCurrency, fromWalletId, toWalletId }),
    eventBus.publish("wallet.balance.updated", { walletId: fromWalletId, currency: fromCurrency }),
    eventBus.publish("wallet.balance.updated", { walletId: toWalletId, currency: toCurrency }),
  ]);

  recordMetric("transaction", Date.now() - start, "transfer");
  return { transaction: finalTx, amountReceived, totalDebit };
}

// ── processWithdrawal (Cash-out) ──────────────────────────────────────────────
// Moves money OUT of the platform. Fee engine is applied here.
// Ledger entries (double-entry, balanced):
//   DEBIT  user wallet     : full amount      (user pays)
//   CREDIT platform_float  : netAmount        (funds exit the platform)
//   CREDIT platform_fees   : feeAmount        (retained by KOWRI — never 0 entry)
//
// Note: if feeAmount === 0, the platform_fees credit entry is still written for
// audit completeness, but with creditAmount "0" so the ledger remains balanced.

export async function processWithdrawal(params: {
  walletId:       string;
  amount:         number;
  currency:       string;
  reference?:     string;
  description?:   string;
  userTier?:      string;
  idempotencyKey?: string;
  skipKycCheck?:  boolean;
  internal?:      boolean;
  attach?:        AttachedWrite;
}): Promise<{ transaction: typeof transactionsTable.$inferSelect; feeAmount: number; netAmount: number; rateBps: number }> {
  const { walletId, currency, description, idempotencyKey, userTier = "bronze", skipKycCheck, internal, attach } = params;
  const amount = normalizeAmount(params.amount);
  const start = Date.now();

  guard("outbound_transfers");

  // Compute fee BEFORE the transaction — async DB read, non-blocking to hot path
  const { feeAmount, netAmount, rateBps } = await computeFee("cashout", amount, userTier);
  // A misconfigured rule (fee above the amount, or negative) must never reach the ledger.
  if (!Number.isFinite(feeAmount) || feeAmount < 0 || netAmount < 0) {
    throw new InvalidFeeError(`Cash-out fee ${feeAmount} is invalid for amount ${amount}`);
  }

  const txId = generateId();
  const ref  = params.reference ?? generateReference();
  const now  = new Date();

  await assertTransactionAllowed({ walletId, transactionId: txId, amount, currency, kind: "withdrawal", internal });

  await runTx(async (tx) => {
    const locked = await lockWallets(tx as any, [walletId]);
    assertWalletUsable(locked, walletId, currency, "debit");

    // Cash-out is capped by the same KYC ceiling as transfers, evaluated under the wallet lock.
    if (!skipKycCheck) await enforceKycLimit(tx as any, walletId, amount, currency);

    const availableBal = await ledgerBalance(tx as any, walletId, currency);
    if (availableBal < amount) throw new Error("Insufficient funds");

    assertValidTransition("pending", "processing");

    await tx.insert(transactionsTable).values({
      id:             txId,
      fromWalletId:   walletId,
      amount:         String(amount),
      currency,
      type:           "withdrawal",
      status:         "processing",
      reference:      ref,
      description:    description ?? "Cash-out",
      idempotencyKey: idempotencyKey ?? null,
    });

    assertValidTransition("processing", "completed");

    const ledgerStart = Date.now();

    await tx.insert(ledgerEntriesTable).values([
      // 1. DEBIT user wallet — full amount leaves the user
      {
        id:           generateId(),
        transactionId: txId,
        accountId:    walletId,
        accountType:  "wallet",
        debitAmount:  String(amount),
        creditAmount: "0",
        currency,
        eventType:    "withdrawal",
        description:  "Cash-out debit",
        entryType:    "debit",
        walletId,
        reference:    ref,
      },
      // 2. CREDIT platform_float — net funds leaving the platform
      {
        id:           generateId(),
        transactionId: txId,
        accountId:    "platform_float",
        accountType:  "platform",
        debitAmount:  "0",
        creditAmount: String(netAmount),
        currency,
        eventType:    "withdrawal",
        description:  "Cash-out net credit (external)",
        entryType:    "credit",
        walletId:     null,
        reference:    ref,
      },
      // 3. CREDIT platform_fees — KOWRI fee revenue (only when a fee applies:
      //    the ledger refuses entries that carry no amount on either side)
      ...(feeAmount > 0 ? [{
        id:           generateId(),
        transactionId: txId,
        accountId:    "platform_fees",
        accountType:  "platform",
        debitAmount:  "0",
        creditAmount: String(feeAmount),
        currency,
        eventType:    "fee",
        description:  `Cash-out fee @ ${rateBps}bps`,
        entryType:    "credit",
        walletId:     null,
        reference:    ref,
      }] : []),
    ]);

    recordMetric("ledger", Date.now() - ledgerStart);

    await syncWalletBalance(walletId, tx as any);

    if (attach) await attach(tx as any);

    await tx
      .update(transactionsTable)
      .set({ status: "completed", completedAt: now })
      .where(eq(transactionsTable.id, txId));
  });

  const [finalTx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, txId));

  await Promise.all([
    audit({
      action:   "transaction.created",
      entity:   "transaction",
      entityId: txId,
      metadata: { type: "withdrawal", amount, netAmount, feeAmount, rateBps, currency, walletId },
    }),
    audit({
      action:   "fee.applied",
      entity:   "transaction",
      entityId: txId,
      metadata: { feeAmount, rateBps, operationType: "cashout", userTier },
    }),
    eventBus.publish("transaction.created", { txId, type: "withdrawal", amount, netAmount, feeAmount, currency, walletId }),
    eventBus.publish("wallet.balance.updated", { walletId, currency }),
  ]);

  recordMetric("transaction", Date.now() - start, "withdrawal");
  return { transaction: finalTx, feeAmount, netAmount, rateBps };
}

// ── reverseTransaction ────────────────────────────────────────────────────────
// Books the mirror image of a completed deposit or transfer so a saga can undo the
// money it moved. The original is marked "reversed"; the reversal is its own transaction.
export async function reverseTransaction(params: {
  transactionId: string;
  reason: string;
  idempotencyKey?: string;
}): Promise<typeof transactionsTable.$inferSelect> {
  const { transactionId, reason, idempotencyKey } = params;
  const [original] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, transactionId));
  if (!original) throw new Error(`Transaction ${transactionId} not found`);
  if (original.status === "reversed") {
    const [existing] = await db.select().from(transactionsTable)
      .where(eq(transactionsTable.idempotencyKey, idempotencyKey ?? `reversal:${transactionId}`)).limit(1);
    if (existing) return existing;
    throw new Error(`Transaction ${transactionId} is already reversed`);
  }
  if (original.status !== "completed") throw new Error(`Only completed transactions can be reversed (status: ${original.status})`);
  if (original.type !== "deposit" && original.type !== "transfer") {
    throw new Error(`Reversal is not supported for ${original.type} transactions`);
  }

  const amount = Number(original.amount);
  const currency = original.currency;
  const reversalId = generateId();
  const ref = generateReference();
  const now = new Date();
  const key = idempotencyKey ?? `reversal:${transactionId}`;

  await runTx(async (tx) => {
    const wallets = [original.fromWalletId, original.toWalletId].filter((w): w is string => !!w);
    const locked = await lockWallets(tx as any, wallets);
    // The wallet that received the original funds must still be able to give them back.
    if (original.toWalletId) {
      const w = locked.get(original.toWalletId);
      if (!w) throw new Error(`Wallet ${original.toWalletId} not found`);
      if (w.status === "closed") throw new WalletUnavailableError(original.toWalletId, w.status, "debit");
      const bal = await ledgerBalance(tx as any, original.toWalletId, currency);
      if (bal < amount) throw new Error("Insufficient funds to reverse");
    }
    if (original.fromWalletId) {
      const w = locked.get(original.fromWalletId);
      if (!w) throw new Error(`Wallet ${original.fromWalletId} not found`);
      if (w.status === "closed") throw new WalletUnavailableError(original.fromWalletId, w.status, "credit");
    }

    await tx.insert(transactionsTable).values({
      id: reversalId,
      fromWalletId: original.toWalletId,
      toWalletId: original.fromWalletId,
      amount: String(amount),
      currency,
      type: original.type,
      status: "processing",
      reference: ref,
      description: `Reversal of ${original.reference}: ${reason}`,
      idempotencyKey: key,
      metadata: { reversalOf: transactionId, reason },
    });

    const base = { transactionId: reversalId, reference: ref, eventType: "reversal", currency };
    const entries: Array<typeof ledgerEntriesTable.$inferInsert> = [];
    if (original.toWalletId) {
      entries.push({ id: generateId(), ...base, accountId: original.toWalletId, accountType: "wallet", debitAmount: String(amount), creditAmount: "0", description: "Reversal debit", entryType: "debit", walletId: original.toWalletId });
    }
    if (original.fromWalletId) {
      entries.push({ id: generateId(), ...base, accountId: original.fromWalletId, accountType: "wallet", debitAmount: "0", creditAmount: String(amount), description: "Reversal credit", entryType: "credit", walletId: original.fromWalletId });
    } else {
      entries.push({ id: generateId(), ...base, accountId: "platform_float", accountType: "platform", debitAmount: "0", creditAmount: String(amount), description: "Reversal — funds returned to platform float", entryType: "credit", walletId: null });
    }
    await tx.insert(ledgerEntriesTable).values(entries);

    for (const w of wallets) await syncWalletBalance(w, tx as any);

    await tx.update(transactionsTable).set({ status: "completed", completedAt: now }).where(eq(transactionsTable.id, reversalId));
    await tx.update(transactionsTable).set({ status: "reversed" }).where(eq(transactionsTable.id, transactionId));
  });

  const [finalTx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, reversalId));
  await Promise.all([
    audit({ action: "transaction.reversed", entity: "transaction", entityId: transactionId, metadata: { reversalId, amount, currency, reason } }),
    ...[original.fromWalletId, original.toWalletId].filter(Boolean).map((w) => eventBus.publish("wallet.balance.updated", { walletId: w, currency })),
  ]);
  return finalTx;
}

export function isDuplicateIdempotencyKey(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string } | undefined;
  return e?.code === "23505" && (e.constraint?.includes("idempotency") || e.message?.includes("idempotency") || false);
}

export async function withDeadlockRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isDeadlock = err?.code === "40P01" || err?.code === "40001";
      if (isDeadlock && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 50 + Math.random() * 30));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}
