import { db } from "@workspace/db";
import {
  remittanceCorridorsTable, beneficiariesTable, recurringTransfersTable,
  walletsTable, usersTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { generateId } from "./id";
import { processFxTransfer } from "./walletService";
import { getRate } from "./fxEngine";
import { eventBus } from "./eventBus";
import { audit } from "./auditLogger";

const SEED_CORRIDORS = [
  { fromCountry: "FR", toCountry: "SN", fromCurrency: "EUR", toCurrency: "XOF", processorId: "wise_global",    flatFee: "500",    percentFee: "0.5", estimatedMins: 30  },
  { fromCountry: "FR", toCountry: "CI", fromCurrency: "EUR", toCurrency: "XOF", processorId: "flutterwave",    flatFee: "500",    percentFee: "0.7", estimatedMins: 60  },
  { fromCountry: "GB", toCountry: "GH", fromCurrency: "GBP", toCurrency: "GHS", processorId: "wise_global",    flatFee: "200",    percentFee: "0.5", estimatedMins: 30  },
  { fromCountry: "US", toCountry: "NG", fromCurrency: "USD", toCurrency: "NGN", processorId: "flutterwave",    flatFee: "300",    percentFee: "1.0", estimatedMins: 60  },
  { fromCountry: "US", toCountry: "KE", fromCurrency: "USD", toCurrency: "KES", processorId: "flutterwave",    flatFee: "300",    percentFee: "1.0", estimatedMins: 60  },
  { fromCountry: "DE", toCountry: "CM", fromCurrency: "EUR", toCurrency: "XAF", processorId: "swift_europe",   flatFee: "1000",   percentFee: "0.5", estimatedMins: 120 },
  { fromCountry: "CA", toCountry: "SN", fromCurrency: "USD", toCurrency: "XOF", processorId: "flutterwave",    flatFee: "500",    percentFee: "1.0", estimatedMins: 90  },
  { fromCountry: "AE", toCountry: "EG", fromCurrency: "USD", toCurrency: "USD", processorId: "swift_europe",   flatFee: "200",    percentFee: "0.5", estimatedMins: 60  },
];

export async function seedCorridors(): Promise<void> {
  const existing = await db.select({ id: remittanceCorridorsTable.id }).from(remittanceCorridorsTable).limit(1);
  if (existing.length > 0) return;

  for (const c of SEED_CORRIDORS) {
    await db.insert(remittanceCorridorsTable).values({
      id: generateId(), ...c,
      maxAmount: "5000000", minAmount: "100",
    });
  }
}

export async function listCorridors(fromCountry?: string, toCountry?: string) {
  const rows = await db.select().from(remittanceCorridorsTable)
    .where(eq(remittanceCorridorsTable.active, true));
  return rows.filter(r =>
    (!fromCountry || r.fromCountry === fromCountry) &&
    (!toCountry   || r.toCountry   === toCountry)
  ).map(r => ({
    ...r,
    flatFee:    Number(r.flatFee),
    percentFee: Number(r.percentFee),
    maxAmount:  Number(r.maxAmount),
    minAmount:  Number(r.minAmount),
  }));
}

export async function addBeneficiary(params: {
  userId: string; name: string; phone?: string; walletId?: string;
  relationship: string; country: string; currency: string;
}): Promise<typeof beneficiariesTable.$inferSelect> {
  const [bene] = await db.insert(beneficiariesTable).values({
    id: generateId(), ...params,
    phone:    params.phone    ?? null,
    walletId: params.walletId ?? null,
  }).returning();

  await eventBus.publish("beneficiary.added", { userId: params.userId, beneficiaryId: bene.id });
  return bene;
}

export async function getBeneficiaries(userId: string) {
  return db.select().from(beneficiariesTable)
    .where(and(eq(beneficiariesTable.userId, userId), eq(beneficiariesTable.active, true)));
}

export async function sendRemittance(params: {
  fromWalletId: string; senderUserId: string; beneficiaryId: string;
  amount: number; fromCurrency: string; toCurrency: string;
  description?: string; idempotencyKey?: string;
}): Promise<{ txId: string; amountSent: number; amountReceived: number; fee: number; totalDebit: number; rate: number; corridor?: string }> {
  if (!Number.isFinite(params.amount) || params.amount <= 0) throw new Error("amount must be a positive number");

  const [bene] = await db.select().from(beneficiariesTable)
    .where(and(eq(beneficiariesTable.id, params.beneficiaryId), eq(beneficiariesTable.userId, params.senderUserId), eq(beneficiariesTable.active, true)));
  if (!bene) throw new Error("Beneficiary not found");

  const [senderWallet] = await db.select({ userId: walletsTable.userId, currency: walletsTable.currency })
    .from(walletsTable).where(eq(walletsTable.id, params.fromWalletId)).limit(1);
  if (!senderWallet || senderWallet.userId !== params.senderUserId) throw new Error("Source wallet not found");
  if (senderWallet.currency !== params.fromCurrency) {
    throw new Error(`Source wallet is denominated in ${senderWallet.currency}, not ${params.fromCurrency}`);
  }

  const corridors = await db.select().from(remittanceCorridorsTable)
    .where(and(
      eq(remittanceCorridorsTable.fromCurrency, params.fromCurrency),
      eq(remittanceCorridorsTable.toCurrency, params.toCurrency),
      eq(remittanceCorridorsTable.active, true),
    ));

  const corridor = corridors[0];
  let fee = 0;
  if (corridor) {
    if (params.amount < Number(corridor.minAmount)) throw new Error(`Minimum amount for this corridor is ${corridor.minAmount} ${params.fromCurrency}`);
    if (params.amount > Number(corridor.maxAmount)) throw new Error(`Maximum amount for this corridor is ${corridor.maxAmount} ${params.fromCurrency}`);
    fee = Math.round((Number(corridor.flatFee) + (params.amount * Number(corridor.percentFee) / 100)) * 10000) / 10000;
  }

  let toWalletId = bene.walletId;
  if (!toWalletId) {
    if (!bene.phone) throw new Error("Beneficiary has neither a wallet nor a phone number");
    const [recipientUser] = await db.select().from(usersTable)
      .where(eq(usersTable.phone, bene.phone));
    if (!recipientUser) throw new Error("Recipient not found on platform — wallet ID required");
    const recipientWallets = await db.select().from(walletsTable)
      .where(and(eq(walletsTable.userId, recipientUser.id), eq(walletsTable.status, "active")));
    const wallet = recipientWallets.find(w => w.currency === params.toCurrency && w.walletType === "personal")
      ?? recipientWallets.find(w => w.currency === params.toCurrency);
    if (!wallet) throw new Error(`Recipient has no ${params.toCurrency} wallet`);
    toWalletId = wallet.id;
  }

  const [recipientWallet] = await db.select({ currency: walletsTable.currency })
    .from(walletsTable).where(eq(walletsTable.id, toWalletId)).limit(1);
  if (!recipientWallet) throw new Error("Recipient wallet not found");
  if (recipientWallet.currency !== params.toCurrency) {
    throw new Error(`Recipient wallet is denominated in ${recipientWallet.currency}, not ${params.toCurrency}`);
  }

  // A missing rate must fail the transfer — never silently fall back to 1:1.
  const rate = await getRate(params.fromCurrency, params.toCurrency);

  const { transaction: tx, amountReceived, totalDebit } = await processFxTransfer({
    fromWalletId:  params.fromWalletId,
    toWalletId,
    amount:        params.amount,
    fee,
    fromCurrency:  params.fromCurrency,
    toCurrency:    params.toCurrency,
    rate,
    description:   params.description ?? `Remittance to ${bene.name}`,
    idempotencyKey: params.idempotencyKey,
  });

  await audit({ action: "remittance.sent", entity: "transaction", entityId: tx.id,
    metadata: { senderUserId: params.senderUserId, beneficiaryId: params.beneficiaryId, amount: params.amount, fee, rate, amountReceived, corridorId: corridor?.id ?? null } });
  await eventBus.publish("remittance.sent", {
    txId: tx.id, senderUserId: params.senderUserId, beneficiaryId: params.beneficiaryId,
    amountSent: params.amount, amountReceived, fee, rate,
  });

  return { txId: tx.id, amountSent: params.amount, amountReceived, fee, totalDebit, rate, corridor: corridor?.id };
}

export async function createRecurringTransfer(params: {
  userId: string; fromWalletId: string; beneficiaryId: string; toWalletId?: string;
  amount: number; currency: string; frequency: string; description?: string; maxRuns?: number;
}): Promise<typeof recurringTransfersTable.$inferSelect> {
  const nextRunAt = new Date();
  if (params.frequency === "weekly")        nextRunAt.setDate(nextRunAt.getDate() + 7);
  else if (params.frequency === "biweekly") nextRunAt.setDate(nextRunAt.getDate() + 14);
  else                                      nextRunAt.setMonth(nextRunAt.getMonth() + 1);

  const [recurring] = await db.insert(recurringTransfersTable).values({
    id:            generateId(),
    userId:        params.userId,
    fromWalletId:  params.fromWalletId,
    beneficiaryId: params.beneficiaryId,
    toWalletId:    params.toWalletId ?? null,
    amount:        String(params.amount),
    currency:      params.currency,
    frequency:     params.frequency,
    nextRunAt,
    description:   params.description ?? null,
    maxRuns:       params.maxRuns ?? null,
  }).returning();

  await eventBus.publish("recurring.transfer.created", { recurringId: recurring.id, userId: params.userId });
  return recurring;
}

export async function runDueRecurringTransfers(): Promise<{ ran: number; failed: number }> {
  const now = new Date();
  const due = await db.select().from(recurringTransfersTable)
    .where(and(eq(recurringTransfersTable.status, "active"),
      sql`${recurringTransfersTable.nextRunAt} <= ${now.toISOString()}`));

  let ran = 0, failed = 0;

  for (const r of due) {
    try {
      await sendRemittance({
        fromWalletId:  r.fromWalletId,
        senderUserId:  r.userId,
        beneficiaryId: r.beneficiaryId,
        amount:        Number(r.amount),
        fromCurrency:  r.currency,
        toCurrency:    r.currency,
        description:   r.description ?? "Recurring transfer",
        idempotencyKey: `recurring:${r.id}:run:${r.runCount + 1}`,
      });

      const nextRunAt = new Date();
      if (r.frequency === "weekly")        nextRunAt.setDate(nextRunAt.getDate() + 7);
      else if (r.frequency === "biweekly") nextRunAt.setDate(nextRunAt.getDate() + 14);
      else                                 nextRunAt.setMonth(nextRunAt.getMonth() + 1);

      const newCount = r.runCount + 1;
      const isExhausted = r.maxRuns != null && newCount >= r.maxRuns;

      await db.update(recurringTransfersTable).set({
        runCount: newCount, lastRunAt: now, nextRunAt,
        status: isExhausted ? "completed" : "active",
      }).where(eq(recurringTransfersTable.id, r.id));
      ran++;
    } catch {
      failed++;
    }
  }

  return { ran, failed };
}
