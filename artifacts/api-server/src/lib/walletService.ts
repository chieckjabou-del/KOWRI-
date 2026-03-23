import { db } from "@workspace/db";
import { ledgerEntriesTable, walletsTable, transactionsTable, usersTable } from "@workspace/db";
import { eq, sql, and, gte } from "drizzle-orm";
import { generateId, generateReference } from "./id";
import { assertValidTransition } from "./stateMachine";
import { audit } from "./auditLogger";
import { eventBus } from "./eventBus";
import { recordMetric } from "./metrics";
import { checkRateLimit, RateLimitExceededError } from "./rateLimiter";
import { runFraudCheck } from "./fraudEngine";
import { guard } from "./killSwitch";
import { computeFee } from "./feeEngine";

export async function getWalletBalance(walletId: string): Promise<number> {
  const [result] = await db
    .select({
      balance: sql<number>`
        COALESCE(SUM(CAST(${ledgerEntriesTable.creditAmount} AS NUMERIC)), 0) -
        COALESCE(SUM(CAST(${ledgerEntriesTable.debitAmount} AS NUMERIC)), 0)
      `,
    })
    .from(ledgerEntriesTable)
    .where(
      sql`${ledgerEntriesTable.accountId} = ${walletId} AND ${ledgerEntriesTable.accountType} = 'wallet'`
    );
  return Number(result?.balance ?? 0);
}

export async function syncWalletBalance(
  walletId: string,
  txClient?: typeof db
): Promise<number> {
  const client = txClient ?? db;
  const [result] = await client
    .select({
      balance: sql<number>`
        COALESCE(SUM(CAST(${ledgerEntriesTable.creditAmount} AS NUMERIC)), 0) -
        COALESCE(SUM(CAST(${ledgerEntriesTable.debitAmount} AS NUMERIC)), 0)
      `,
    })
    .from(ledgerEntriesTable)
    .where(
      sql`${ledgerEntriesTable.accountId} = ${walletId} AND ${ledgerEntriesTable.accountType} = 'wallet'`
    );

  const derived = Number(result?.balance ?? 0);

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
    const derived = await getWalletBalance(w.id);
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
}): Promise<typeof transactionsTable.$inferSelect> {
  const { walletId, amount, currency, reference, description, idempotencyKey } = params;
  const start = Date.now();
  const txId = generateId();
  const now = new Date();

  let txRecord: typeof transactionsTable.$inferSelect;

  await db.transaction(async (tx) => {
    const lockResult = await tx.execute(
      sql`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`
    );
    if ((lockResult as any).rows?.length === 0) throw new Error("Wallet not found");

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
    (txRecord as any) = { newBalance };

    await tx
      .update(transactionsTable)
      .set({ status: "completed", completedAt: now })
      .where(eq(transactionsTable.id, txId));
  });

  const [finalTx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, txId));
  const newBalance = (txRecord as any)?.newBalance;

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

export async function getMonthlyVolume(fromWalletId: string): Promise<number> {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [result] = await db
    .select({ total: sql<number>`COALESCE(SUM(CAST(${transactionsTable.amount} AS NUMERIC)), 0)` })
    .from(transactionsTable)
    .where(and(
      eq(transactionsTable.fromWalletId, fromWalletId),
      eq(transactionsTable.type, "transfer"),
      gte(transactionsTable.createdAt, startOfMonth),
    ));
  return Number(result?.total ?? 0);
}

async function enforceKycLimit(fromWalletId: string, amount: number): Promise<void> {
  const [wallet] = await db
    .select({ userId: walletsTable.userId })
    .from(walletsTable)
    .where(eq(walletsTable.id, fromWalletId))
    .limit(1);
  if (!wallet) return;

  const [user] = await db
    .select({ kycLevel: usersTable.kycLevel })
    .from(usersTable)
    .where(eq(usersTable.id, wallet.userId))
    .limit(1);

  const kycLevel = user?.kycLevel ?? 0;
  const monthlyLimit = KYC_MONTHLY_LIMITS[kycLevel] ?? KYC_MONTHLY_LIMITS[0];
  const monthlyVolume = await getMonthlyVolume(fromWalletId);

  if (monthlyVolume + amount > monthlyLimit) {
    throw new Error(
      `Limite mensuelle atteinte (${monthlyLimit.toLocaleString("fr-FR")} XOF). ` +
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
}): Promise<typeof transactionsTable.$inferSelect> {
  const { fromWalletId, toWalletId, amount, currency, description, reference, idempotencyKey, skipRateLimitCheck, skipFraudCheck, skipKycCheck } = params;
  const start = Date.now();

  // ── INTERNAL TRANSFERS ARE ALWAYS FREE ────────────────────────────────────
  // Fee engine is explicitly bypassed for wallet-to-wallet (P2P) transfers.
  // This is a deliberate architectural invariant — not a "no rule found = 0"
  // fallback. Any fee on internal transfers would be economically incorrect and
  // must NEVER be introduced via fee_config rules.
  // ──────────────────────────────────────────────────────────────────────────

  guard("outbound_transfers");   // throws KillSwitchError if switch is TRIGGERED or FORCED_OFF

  if (!skipKycCheck) {
    await enforceKycLimit(fromWalletId, amount);
  }

  if (!skipRateLimitCheck) {
    await checkRateLimit(fromWalletId, amount);
  }

  const txId = generateId();
  const ref = reference ?? generateReference();
  const now = new Date();

  await db.transaction(async (tx) => {
    const lockResult = await tx.execute(
      sql`SELECT id FROM wallets WHERE id IN (${fromWalletId}, ${toWalletId}) ORDER BY id FOR UPDATE`
    );
    if ((lockResult as any).rows?.length < 2) throw new Error("One or both wallets not found");

    const [balResult] = await tx
      .select({
        balance: sql<number>`
          COALESCE(SUM(CAST(${ledgerEntriesTable.creditAmount} AS NUMERIC)), 0) -
          COALESCE(SUM(CAST(${ledgerEntriesTable.debitAmount} AS NUMERIC)), 0)
        `,
      })
      .from(ledgerEntriesTable)
      .where(sql`${ledgerEntriesTable.accountId} = ${fromWalletId} AND ${ledgerEntriesTable.accountType} = 'wallet'`);

    const availableBal = Number(balResult?.balance ?? 0);
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

  if (!skipFraudCheck) {
    setImmediate(() => {
      runFraudCheck(fromWalletId, amount, currency).catch((err) =>
        console.error("[FraudEngine] Post-commit check failed:", err)
      );
    });
  }

  recordMetric("transaction", Date.now() - start, "transfer");
  return finalTx;
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
}): Promise<{ transaction: typeof transactionsTable.$inferSelect; feeAmount: number; netAmount: number; rateBps: number }> {
  const { walletId, amount, currency, description, idempotencyKey, userTier = "bronze" } = params;
  const start = Date.now();

  guard("outbound_transfers");

  // Compute fee BEFORE the transaction — async DB read, non-blocking to hot path
  const { feeAmount, netAmount, rateBps } = await computeFee("cashout", amount, userTier);

  const txId = generateId();
  const ref  = params.reference ?? generateReference();
  const now  = new Date();

  await db.transaction(async (tx) => {
    const lockResult = await tx.execute(
      sql`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`
    );
    if ((lockResult as any).rows?.length === 0) throw new Error("Wallet not found");

    const [balResult] = await tx
      .select({
        balance: sql<number>`
          COALESCE(SUM(CAST(${ledgerEntriesTable.creditAmount} AS NUMERIC)), 0) -
          COALESCE(SUM(CAST(${ledgerEntriesTable.debitAmount} AS NUMERIC)), 0)
        `,
      })
      .from(ledgerEntriesTable)
      .where(sql`${ledgerEntriesTable.accountId} = ${walletId} AND ${ledgerEntriesTable.accountType} = 'wallet'`);

    const availableBal = Number(balResult?.balance ?? 0);
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
      // 3. CREDIT platform_fees — KOWRI fee revenue (always written for audit)
      {
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
      },
    ]);

    recordMetric("ledger", Date.now() - ledgerStart);

    await syncWalletBalance(walletId, tx as any);

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
