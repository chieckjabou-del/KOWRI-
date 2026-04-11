import { db } from "@workspace/db";
import {
  creditScoresTable,
  tontineCyclesTable,
  tontineMembersTable,
  tontinePaymentsTable,
  tontinePenaltiesTable,
  tontinePayoutsTable,
  tontinesTable,
  walletsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { generateId, generateReference } from "./id";
import { computeReputationScore } from "./reputationEngine";
import { processTransfer } from "./walletService";

const DEFAULT_PENALTY_RATE = 0.1;
const MIN_RELIABILITY_TO_JOIN = 35;
const MIN_CREDIT_SCORE_TO_JOIN = 250;

function addByFrequency(base: Date, frequency: string): Date {
  const d = new Date(base);
  if (frequency === "weekly") d.setDate(d.getDate() + 7);
  else if (frequency === "biweekly") d.setDate(d.getDate() + 14);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

function computeReliabilityFromMember(member: {
  contributionsCount: number;
  missedContributions: number;
}): number {
  const paid = Number(member.contributionsCount ?? 0);
  const missed = Number(member.missedContributions ?? 0);
  const total = paid + missed;
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((paid / total) * 100)));
}

async function getOrCreateCycle(tontineId: string, roundNumber: number): Promise<typeof tontineCyclesTable.$inferSelect> {
  const [existing] = await db.select().from(tontineCyclesTable).where(
    and(
      eq(tontineCyclesTable.tontineId, tontineId),
      eq(tontineCyclesTable.roundNumber, roundNumber),
    ),
  );
  if (existing) return existing;

  const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
  if (!tontine) throw new Error("Tontine introuvable");

  const dueAt = tontine.nextPayoutDate ?? addByFrequency(new Date(), tontine.frequency);
  const [created] = await db.insert(tontineCyclesTable).values({
    id: generateId("tcy"),
    tontineId,
    roundNumber,
    dueAt,
    status: "open",
    expectedPool: String(Number(tontine.contributionAmount) * Number(tontine.memberCount)),
    collectedPool: "0",
  }).returning();

  return created;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code;
  return code === "23505";
}

async function updateRiskScoresAfterDefault(userId: string): Promise<void> {
  const [score] = await db.select().from(creditScoresTable).where(eq(creditScoresTable.userId, userId));
  if (score) {
    const current = Number(score.score ?? 300);
    const updatedScore = Math.max(100, current - 20);
    await db.update(creditScoresTable)
      .set({ score: updatedScore, lastUpdated: new Date() })
      .where(eq(creditScoresTable.userId, userId));
  }
  await computeReputationScore(userId).catch(() => undefined);
}

function ensureWalletType(value: string): "personal" | "merchant" | "savings" | "tontine" {
  if (value === "personal" || value === "merchant" || value === "savings" || value === "tontine") return value;
  return "personal";
}

export async function createCoreTontine(input: {
  name: string;
  contributionAmount: number;
  currency: string;
  frequency: "weekly" | "biweekly" | "monthly";
  maxMembers: number;
  adminUserId: string;
  description?: string;
}): Promise<typeof tontinesTable.$inferSelect> {
  const [tontine] = await db.transaction(async (tx) => {
    const poolWalletId = generateId("wal");
    await tx.insert(walletsTable).values({
      id: poolWalletId,
      userId: input.adminUserId,
      currency: input.currency,
      balance: "0",
      availableBalance: "0",
      status: "active",
      walletType: "tontine",
    });

    const [created] = await tx.insert(tontinesTable).values({
      id: generateId("ton"),
      name: input.name,
      description: input.description ?? null,
      contributionAmount: String(input.contributionAmount),
      currency: input.currency,
      frequency: input.frequency,
      maxMembers: input.maxMembers,
      memberCount: 1,
      currentRound: 0,
      totalRounds: input.maxMembers,
      status: "pending",
      adminUserId: input.adminUserId,
      walletId: poolWalletId,
    }).returning();

    await tx.insert(tontineMembersTable).values({
      id: generateId("tm"),
      tontineId: created.id,
      userId: input.adminUserId,
      payoutOrder: 1,
      hasReceivedPayout: 0,
      contributionsCount: 0,
      missedContributions: 0,
      memberStatus: "active",
    });

    return [created];
  });

  return tontine;
}

export async function joinCoreTontine(tontineId: string, userId: string): Promise<typeof tontineMembersTable.$inferSelect> {
  const [score] = await db.select().from(creditScoresTable).where(eq(creditScoresTable.userId, userId));
  if (score && Number(score.score) < MIN_CREDIT_SCORE_TO_JOIN) {
    throw new Error("Score de crédit insuffisant pour rejoindre cette tontine");
  }

  const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
  if (!tontine) throw new Error("Tontine introuvable");
  if (tontine.status !== "pending" && tontine.status !== "active") throw new Error("Tontine non ouverte");

  const existing = await db.select().from(tontineMembersTable).where(
    and(
      eq(tontineMembersTable.tontineId, tontineId),
      eq(tontineMembersTable.userId, userId),
    ),
  );
  if (existing[0]) throw new Error("Membre déjà inscrit");

  const priorMemberships = await db.select().from(tontineMembersTable).where(eq(tontineMembersTable.userId, userId));
  const reliability = priorMemberships.length
    ? Math.round(priorMemberships.reduce((s, m) => s + computeReliabilityFromMember(m), 0) / priorMemberships.length)
    : 100;

  if (reliability < MIN_RELIABILITY_TO_JOIN) {
    throw new Error("Fiabilité insuffisante pour rejoindre cette tontine");
  }

  const [member] = await db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!fresh) throw new Error("Tontine introuvable");
    if (fresh.memberCount >= fresh.maxMembers) throw new Error("Tontine complète");

    const nextOrder = Number(fresh.memberCount) + 1;
    let createdMember: typeof tontineMembersTable.$inferSelect | undefined;
    try {
      [createdMember] = await tx.insert(tontineMembersTable).values({
        id: generateId("tm"),
        tontineId,
        userId,
        payoutOrder: nextOrder,
        hasReceivedPayout: 0,
        contributionsCount: 0,
        missedContributions: 0,
        memberStatus: "active",
      }).returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error("Membre déjà inscrit");
      }
      throw err;
    }

    await tx.update(tontinesTable).set({
      memberCount: nextOrder,
      totalRounds: nextOrder,
    }).where(eq(tontinesTable.id, tontineId));

    return [createdMember];
  });

  return member;
}

export async function assignCorePositions(tontineId: string): Promise<void> {
  const members = await db.select().from(tontineMembersTable).where(eq(tontineMembersTable.tontineId, tontineId));
  const ordered = [...members].sort((a, b) => (new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()));
  await db.transaction(async (tx) => {
    for (let i = 0; i < ordered.length; i++) {
      await tx.update(tontineMembersTable)
        .set({ payoutOrder: i + 1 })
        .where(eq(tontineMembersTable.id, ordered[i].id));
    }
  });
}

export async function collectMemberPayment(input: {
  tontineId: string;
  userId: string;
  idempotencyKey: string;
}): Promise<{ payment: typeof tontinePaymentsTable.$inferSelect; penaltyApplied: number }> {
  const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, input.tontineId));
  if (!tontine) throw new Error("Tontine introuvable");
  if (!tontine.walletId) throw new Error("Wallet de tontine non configuré");
  if (tontine.status !== "active") throw new Error("Tontine non active");

  const [member] = await db.select().from(tontineMembersTable).where(
    and(
      eq(tontineMembersTable.tontineId, input.tontineId),
      eq(tontineMembersTable.userId, input.userId),
    ),
  );
  if (!member) throw new Error("Membre introuvable");
  if (member.memberStatus !== "active") throw new Error("Membre suspendu");

  const roundNumber = Number(tontine.currentRound) + 1;
  const cycle = await getOrCreateCycle(input.tontineId, roundNumber);

  const [existingPayment] = await db.select().from(tontinePaymentsTable).where(
    and(
      eq(tontinePaymentsTable.cycleId, cycle.id),
      eq(tontinePaymentsTable.memberId, member.id),
    ),
  );

  if (existingPayment && existingPayment.status !== "defaulted") {
    throw new Error("Paiement déjà enregistré pour ce cycle");
  }

  const dueAt = new Date(cycle.dueAt);
  const isLate = Date.now() > dueAt.getTime();
  const baseDue = Number(member.personalContribution ?? tontine.contributionAmount);
  const penalty = isLate ? Number((baseDue * DEFAULT_PENALTY_RATE).toFixed(4)) : 0;
  const totalToPay = baseDue + penalty;

  const memberWallets = await db.select().from(walletsTable).where(
    and(eq(walletsTable.userId, input.userId), eq(walletsTable.status, "active")),
  );
  const fromWallet =
    memberWallets.find((w) => w.walletType === "personal") ??
    memberWallets.find((w) => w.walletType !== "tontine") ??
    memberWallets[0];
  if (!fromWallet) throw new Error("Wallet membre introuvable");

  const reference = generateReference();
  const tx = await processTransfer({
    fromWalletId: fromWallet.id,
    toWalletId: tontine.walletId,
    amount: totalToPay,
    currency: tontine.currency,
    description: `Tontine payment round ${roundNumber}`,
    reference,
    idempotencyKey: input.idempotencyKey,
    skipFraudCheck: true,
  });

  const [payment] = await db.transaction(async (trx) => {
    let paymentId = existingPayment?.id ?? null;
    if (!paymentId) {
      const [created] = await trx.insert(tontinePaymentsTable).values({
        id: generateId("tpay"),
        tontineId: input.tontineId,
        cycleId: cycle.id,
        roundNumber,
        memberId: member.id,
        userId: input.userId,
        amountDue: String(baseDue),
        penaltyAmount: String(penalty),
        amountPaid: String(totalToPay),
        currency: tontine.currency,
        status: isLate ? "late" : "completed",
        paidAt: new Date(),
        dueAt,
        idempotencyKey: input.idempotencyKey,
        txId: tx.id,
      }).returning();
      paymentId = created.id;
    } else {
      await trx.update(tontinePaymentsTable).set({
        amountDue: String(baseDue),
        penaltyAmount: String(penalty),
        amountPaid: String(totalToPay),
        status: isLate ? "late" : "completed",
        paidAt: new Date(),
        dueAt,
        idempotencyKey: input.idempotencyKey,
        txId: tx.id,
      }).where(eq(tontinePaymentsTable.id, paymentId));
    }

    if (penalty > 0) {
      await trx.insert(tontinePenaltiesTable).values({
        id: generateId("tpen"),
        tontineId: input.tontineId,
        cycleId: cycle.id,
        roundNumber,
        memberId: member.id,
        userId: input.userId,
        paymentId,
        amount: String(penalty),
        currency: tontine.currency,
        reason: "late_payment",
        status: "settled",
        assessedAt: new Date(),
        settledAt: new Date(),
      });
    }

    await trx.update(tontineMembersTable).set({
      contributionsCount: sql`${tontineMembersTable.contributionsCount} + 1`,
    }).where(eq(tontineMembersTable.id, member.id));

    await trx.update(tontineCyclesTable).set({
      status: "collecting",
      collectedPool: sql`${tontineCyclesTable.collectedPool}::numeric + ${totalToPay}`,
    }).where(eq(tontineCyclesTable.id, cycle.id));

    const [updatedPayment] = await trx.select().from(tontinePaymentsTable).where(eq(tontinePaymentsTable.id, paymentId));
    return [updatedPayment];
  });

  return { payment, penaltyApplied: penalty };
}

export async function finalizeCoreCycleAndPayout(tontineId: string): Promise<{
  cycle: typeof tontineCyclesTable.$inferSelect;
  payout: typeof tontinePayoutsTable.$inferSelect;
}> {
  const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
  if (!tontine) throw new Error("Tontine introuvable");
  if (!tontine.walletId) throw new Error("Wallet de tontine non configuré");
  if (tontine.status !== "active") throw new Error("Tontine non active");

  const roundNumber = Number(tontine.currentRound) + 1;
  const [cycle] = await db.select().from(tontineCyclesTable).where(
    and(
      eq(tontineCyclesTable.tontineId, tontineId),
      eq(tontineCyclesTable.roundNumber, roundNumber),
    ),
  );
  if (!cycle) throw new Error("Cycle introuvable");

  const members = await db.select().from(tontineMembersTable).where(eq(tontineMembersTable.tontineId, tontineId));
  if (!members.length) throw new Error("Aucun membre");

  const payments = await db.select().from(tontinePaymentsTable).where(eq(tontinePaymentsTable.cycleId, cycle.id));
  const paidMemberIds = new Set(
    payments
      .filter((p) => p.status === "completed" || p.status === "late")
      .map((p) => p.memberId),
  );

  const unpaid = members.filter((m) => !paidMemberIds.has(m.id));
  const now = new Date();
  const isPastDue = now.getTime() > new Date(cycle.dueAt).getTime();

  if (unpaid.length > 0) {
    if (!isPastDue) {
      throw new Error("Tous les membres doivent payer avant le payout");
    }

    await db.transaction(async (tx) => {
      for (const member of unpaid) {
        const baseDue = Number(member.personalContribution ?? tontine.contributionAmount);
        const penalty = Number((baseDue * DEFAULT_PENALTY_RATE).toFixed(4));

        const [existing] = await tx.select().from(tontinePaymentsTable).where(
          and(
            eq(tontinePaymentsTable.cycleId, cycle.id),
            eq(tontinePaymentsTable.memberId, member.id),
          ),
        );
        if (!existing) {
          const [createdPayment] = await tx.insert(tontinePaymentsTable).values({
            id: generateId("tpay"),
            tontineId,
            cycleId: cycle.id,
            roundNumber,
            memberId: member.id,
            userId: member.userId,
            amountDue: String(baseDue),
            penaltyAmount: String(penalty),
            amountPaid: "0",
            currency: tontine.currency,
            status: "defaulted",
            dueAt: cycle.dueAt,
          }).returning();

          await tx.insert(tontinePenaltiesTable).values({
            id: generateId("tpen"),
            tontineId,
            cycleId: cycle.id,
            roundNumber,
            memberId: member.id,
            userId: member.userId,
            paymentId: createdPayment.id,
            amount: String(penalty),
            currency: tontine.currency,
            reason: "payment_default",
            status: "pending",
          });
        }

        await tx.update(tontineMembersTable).set({
          missedContributions: sql`${tontineMembersTable.missedContributions} + 1`,
          memberStatus: "suspended",
        }).where(eq(tontineMembersTable.id, member.id));
      }
    });

    for (const member of unpaid) {
      await updateRiskScoresAfterDefault(member.userId);
    }
  }

  const [freshCycle] = await db.select().from(tontineCyclesTable).where(eq(tontineCyclesTable.id, cycle.id));
  const [recipient] = await db.select().from(tontineMembersTable).where(
    and(
      eq(tontineMembersTable.tontineId, tontineId),
      eq(tontineMembersTable.payoutOrder, roundNumber),
    ),
  );
  if (!recipient) throw new Error(`Aucun bénéficiaire trouvé pour le round ${roundNumber}`);

  const recipientWallets = await db.select().from(walletsTable).where(
    and(eq(walletsTable.userId, recipient.userId), eq(walletsTable.status, "active")),
  );
  const toWallet =
    recipientWallets.find((w) => w.walletType === "personal") ??
    recipientWallets.find((w) => w.walletType !== "tontine") ??
    recipientWallets[0];
  if (!toWallet) throw new Error("Wallet bénéficiaire introuvable");

  const amount = Number(freshCycle.collectedPool);
  if (amount <= 0) throw new Error("Pool collecté vide");

  const payoutReference = `TONTINE-PAYOUT-${freshCycle.id}`;
  let tx: Awaited<ReturnType<typeof processTransfer>>;
  try {
    tx = await processTransfer({
      fromWalletId: tontine.walletId,
      toWalletId: toWallet.id,
      amount,
      currency: tontine.currency,
      description: `Tontine payout round ${roundNumber}`,
      reference: payoutReference,
      skipFraudCheck: true,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw new Error("Payout déjà traité pour ce cycle");
  }

  const [resultCycle, payout] = await db.transaction(async (trx) => {
    await trx.update(tontineCyclesTable).set({
      status: "payout_completed",
      payoutUserId: recipient.userId,
      payoutAt: new Date(),
      closedAt: new Date(),
    }).where(eq(tontineCyclesTable.id, freshCycle.id));

    let createdPayout: typeof tontinePayoutsTable.$inferSelect | undefined;
    try {
      [createdPayout] = await trx.insert(tontinePayoutsTable).values({
        id: generateId("tpayout"),
        tontineId,
        cycleId: freshCycle.id,
        roundNumber,
        memberId: recipient.id,
        userId: recipient.userId,
        amount: String(amount),
        currency: tontine.currency,
        status: "completed",
        paidAt: new Date(),
        txId: tx.id,
        metadata: { recipientWalletId: toWallet.id, reference: payoutReference },
      }).returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        const [existingPayout] = await trx.select().from(tontinePayoutsTable).where(eq(tontinePayoutsTable.cycleId, freshCycle.id));
        if (!existingPayout) throw new Error("Payout déjà traité pour ce cycle");
        createdPayout = existingPayout;
      } else {
        throw err;
      }
    }

    const isComplete = roundNumber >= Number(tontine.totalRounds);
    await trx.update(tontinesTable).set({
      currentRound: roundNumber,
      status: isComplete ? "completed" : "active",
      nextPayoutDate: isComplete ? null : addByFrequency(new Date(freshCycle.dueAt), tontine.frequency),
    }).where(eq(tontinesTable.id, tontineId));

    await trx.update(tontineMembersTable).set({
      hasReceivedPayout: 1,
      receivedPayoutAt: new Date(),
    }).where(eq(tontineMembersTable.id, recipient.id));

    const [updatedCycle] = await trx.select().from(tontineCyclesTable).where(eq(tontineCyclesTable.id, freshCycle.id));
    return [updatedCycle, createdPayout!] as const;
  });

  return { cycle: resultCycle, payout };
}

export async function getCoreTontineSnapshot(tontineId: string): Promise<{
  tontine: typeof tontinesTable.$inferSelect;
  cycles: Array<typeof tontineCyclesTable.$inferSelect>;
  payments: Array<typeof tontinePaymentsTable.$inferSelect>;
  payouts: Array<typeof tontinePayoutsTable.$inferSelect>;
  penalties: Array<typeof tontinePenaltiesTable.$inferSelect>;
}> {
  const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
  if (!tontine) throw new Error("Tontine introuvable");

  const cycles = await db.select().from(tontineCyclesTable).where(eq(tontineCyclesTable.tontineId, tontineId));
  const payments = await db.select().from(tontinePaymentsTable).where(eq(tontinePaymentsTable.tontineId, tontineId));
  const payouts = await db.select().from(tontinePayoutsTable).where(eq(tontinePayoutsTable.tontineId, tontineId));
  const penalties = await db.select().from(tontinePenaltiesTable).where(eq(tontinePenaltiesTable.tontineId, tontineId));

  return { tontine, cycles, payments, payouts, penalties };
}

export async function applyCorePenaltySettlement(input: {
  penaltyId: string;
  settle: boolean;
  reason?: string;
}): Promise<typeof tontinePenaltiesTable.$inferSelect> {
  const [penalty] = await db.select().from(tontinePenaltiesTable).where(eq(tontinePenaltiesTable.id, input.penaltyId));
  if (!penalty) throw new Error("Pénalité introuvable");
  if (penalty.status !== "pending") return penalty;

  const [updated] = await db.update(tontinePenaltiesTable).set({
    status: input.settle ? "settled" : "waived",
    settledAt: input.settle ? new Date() : null,
    waivedAt: input.settle ? null : new Date(),
    metadata: {
      ...(penalty.metadata as Record<string, unknown> | null ?? {}),
      resolutionReason: input.reason ?? null,
    },
  }).where(eq(tontinePenaltiesTable.id, penalty.id)).returning();

  return updated;
}
