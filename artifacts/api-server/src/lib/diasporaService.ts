import { db } from "@workspace/db";
import {
  remittanceCorridorsTable, beneficiariesTable, recurringTransfersTable,
  walletsTable, usersTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { generateId } from "./id";
import { processTransfer } from "./walletService";
import { convertAmount } from "./fxEngine";
import { eventBus } from "./eventBus";
import { audit } from "./auditLogger";
import { trackFxFeeRevenue } from "./monetizationService";

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
  description?: string;
}): Promise<{ txId: string; amountSent: number; amountReceived: number; fee: number; corridor?: string }> {
  const [bene] = await db.select().from(beneficiariesTable)
    .where(and(eq(beneficiariesTable.id, params.beneficiaryId), eq(beneficiariesTable.userId, params.senderUserId)));
  if (!bene) throw new Error("Beneficiary not found");

  const corridors = await db.select().from(remittanceCorridorsTable)
    .where(and(
      eq(remittanceCorridorsTable.fromCurrency, params.fromCurrency),
      eq(remittanceCorridorsTable.toCurrency, params.toCurrency),
      eq(remittanceCorridorsTable.active, true),
    ));

  const corridor = corridors[0];
  let fee = 0;
  if (corridor) {
    fee = Number(corridor.flatFee) + (params.amount * Number(corridor.percentFee) / 100);
  }

  const totalDebit = params.amount + fee;

  let toWalletId = bene.walletId;
  if (!toWalletId) {
    const [recipientUser] = await db.select().from(usersTable)
      .where(eq(usersTable.phone, bene.phone!));
    if (!recipientUser) throw new Error("Recipient not found on platform — wallet ID required");
    const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.userId, recipientUser.id));
    if (!wallet) throw new Error("Recipient has no wallet");
    toWalletId = wallet.id;
  }

  let amountReceived = params.amount;
  if (params.fromCurrency !== params.toCurrency) {
    try {
      const { convertedAmount } = await convertAmount(params.amount, params.fromCurrency, params.toCurrency);
      amountReceived = convertedAmount;
    } catch {
      amountReceived = params.amount;
    }
  }

  const tx = await processTransfer({
    fromWalletId: params.fromWalletId,
    toWalletId,
    amount:       params.amount,
    currency:     params.fromCurrency,
    description:  params.description ?? `Remittance to ${bene.name}`,
    skipFraudCheck: false,
  });

  await audit({ action: "remittance.sent", entity: "transaction", entityId: tx.id,
    metadata: { senderUserId: params.senderUserId, beneficiaryId: params.beneficiaryId, amount: params.amount, fee } });
  if (fee > 0) {
    await trackFxFeeRevenue({
      userId: params.senderUserId,
      fromCurrency: params.fromCurrency,
      toCurrency: params.toCurrency,
      rate: params.fromCurrency === params.toCurrency ? 1 : Number(amountReceived) / Number(params.amount || 1),
      amount: Number(params.amount),
      fee,
      txId: tx.id,
      metadata: {
        corridorId: corridor?.id ?? null,
        beneficiaryId: params.beneficiaryId,
      },
    });
  }
  await eventBus.publish("remittance.sent", {
    txId: tx.id, senderUserId: params.senderUserId, beneficiaryId: params.beneficiaryId,
    amountSent: params.amount, amountReceived, fee,
  });

  return { txId: tx.id, amountSent: params.amount, amountReceived, fee, corridor: corridor?.id };
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
