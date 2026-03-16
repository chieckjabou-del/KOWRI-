import { db } from "@workspace/db";
import { amlFlagsTable, complianceCasesTable, transactionsTable } from "@workspace/db";
import { eq, or, and, gte, sql } from "drizzle-orm";
import { generateId } from "./id";
import { eventBus } from "./eventBus";
import { messageQueue, MESSAGE_TOPICS } from "./messageQueue";

export type AmlSeverity = "low" | "medium" | "high" | "critical";

interface AmlResult {
  flagged:    boolean;
  reason?:    string;
  severity?:  AmlSeverity;
  caseType?:  string;
}

const HIGH_VALUE_THRESHOLD  = 10_000_000;
const STRUCT_THRESHOLD      = 9_500_000;
const VELOCITY_WINDOW_MINS  = 60;
const VELOCITY_MAX_TXS      = 30;

async function checkHighValue(walletId: string, amount: number): Promise<AmlResult> {
  if (amount >= HIGH_VALUE_THRESHOLD) {
    return { flagged: true, reason: "high_value_transaction", severity: "high", caseType: "high_value_reporting" };
  }
  return { flagged: false };
}

async function checkStructuring(walletId: string, amount: number): Promise<AmlResult> {
  if (amount >= STRUCT_THRESHOLD && amount < HIGH_VALUE_THRESHOLD) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await db.select({ cnt: sql<number>`count(*)` })
      .from(transactionsTable)
      .where(
        and(
          or(
            eq(transactionsTable.fromWalletId, walletId),
            eq(transactionsTable.toWalletId, walletId),
          ),
          gte(transactionsTable.createdAt, since)
        )
      );
    const cnt = Number(rows[0]?.cnt ?? 0);
    if (cnt >= 3) {
      return { flagged: true, reason: "structuring_detected", severity: "critical", caseType: "structuring" };
    }
  }
  return { flagged: false };
}

async function checkVelocity(walletId: string): Promise<AmlResult> {
  const since = new Date(Date.now() - VELOCITY_WINDOW_MINS * 60 * 1000);
  const rows = await db.select({ cnt: sql<number>`count(*)` })
    .from(transactionsTable)
    .where(
      and(
        or(
          eq(transactionsTable.fromWalletId, walletId),
          eq(transactionsTable.toWalletId, walletId),
        ),
        gte(transactionsTable.createdAt, since)
      )
    );
  const cnt = Number(rows[0]?.cnt ?? 0);
  if (cnt >= VELOCITY_MAX_TXS) {
    return { flagged: true, reason: "unusual_velocity", severity: "high", caseType: "transaction_monitoring" };
  }
  return { flagged: false };
}

export async function runAmlChecks(
  walletId:      string,
  transactionId: string,
  amount:        number,
  currency:      string
): Promise<AmlResult[]> {
  const checks = await Promise.all([
    checkHighValue(walletId, amount),
    checkStructuring(walletId, amount),
    checkVelocity(walletId),
  ]);

  const flags = checks.filter((c) => c.flagged);

  for (const flag of flags) {
    const flagId = generateId();
    await db.insert(amlFlagsTable).values({
      id:            flagId,
      walletId,
      transactionId,
      reason:        flag.reason!,
      severity:      flag.severity!,
      metadata:      { amount, currency } as any,
    });

    if (flag.caseType) {
      await db.insert(complianceCasesTable).values({
        id:       generateId(),
        walletId,
        caseType: flag.caseType,
        severity: flag.severity!,
        status:   "open",
        details:  { flagId, transactionId, amount, currency, reason: flag.reason } as any,
      });
    }

    await eventBus.publish("compliance.alert", {
      walletId,
      transactionId,
      reason:   flag.reason,
      severity: flag.severity,
    });

    await eventBus.publish("transaction.flagged", {
      transactionId,
      walletId,
      reason: flag.reason,
    });

    await messageQueue.produce(MESSAGE_TOPICS.COMPLIANCE, {
      event:         "aml.flag",
      walletId,
      transactionId,
      reason:        flag.reason,
      severity:      flag.severity,
      caseType:      flag.caseType,
    });

    console.log(`[AML] FLAG ${flag.severity?.toUpperCase()} | ${flag.reason} | wallet=${walletId}`);
  }

  return flags;
}
