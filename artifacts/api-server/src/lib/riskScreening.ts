import { db } from "@workspace/db";
import { riskAlertsTable, amlFlagsTable, complianceCasesTable, transactionsTable, walletsTable, usersTable } from "@workspace/db";
import { eq, or, and, gte, sql } from "drizzle-orm";
import { generateId } from "./id";
import { eventBus } from "./eventBus";
import { audit } from "./auditLogger";
import { getRate } from "./fxEngine";
import { messageQueue, MESSAGE_TOPICS } from "./messageQueue";

export type Severity = "low" | "medium" | "high" | "critical";
export type FraudAlertType = "rapid_transfers" | "high_value_transfer" | "wallet_draining" | "unusual_pattern" | "burst_activity";
export type ScreeningKind = "transfer" | "deposit" | "withdrawal" | "fx_transfer";

export interface ScreeningInput {
  walletId: string;
  transactionId: string;
  amount: number;
  currency: string;
  kind: ScreeningKind;
  // Internal product flows (tontine cycles, savings, pools, agent float) are still
  // monitored for AML but exempt from velocity rules that batch jobs would trip.
  internal?: boolean;
}

export interface ScreeningFinding {
  engine: "fraud" | "aml";
  type: string;
  severity: Severity;
  reason: string;
  blocking: boolean;
  deduplicated: boolean;
}

export interface ScreeningResult {
  decision: "allow" | "block";
  findings: ScreeningFinding[];
  normalizedXof: number | null;
}

export class TransactionBlockedError extends Error {
  readonly findings: ScreeningFinding[];
  constructor(findings: ScreeningFinding[]) {
    super(`Transaction blocked by risk screening: ${findings.filter(f => f.blocking).map(f => f.type).join(", ")}`);
    this.name = "TransactionBlockedError";
    this.findings = findings;
  }
}

function env(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// All thresholds are expressed in XOF and overridable per environment.
const CONFIG = {
  RAPID_WINDOW_SEC:        env("FRAUD_RAPID_WINDOW_SEC", 30),
  RAPID_ALERT_COUNT:       env("FRAUD_RAPID_ALERT_COUNT", 5),
  RAPID_BLOCK_COUNT:       env("FRAUD_RAPID_BLOCK_COUNT", 10),
  HIGH_VALUE_XOF:          env("FRAUD_HIGH_VALUE_XOF", 1_000_000),
  CRITICAL_VALUE_XOF:      env("FRAUD_CRITICAL_VALUE_XOF", 5_000_000),
  DRAIN_PCT:               env("FRAUD_DRAIN_PCT", 0.8),
  AML_HIGH_VALUE_XOF:      env("AML_HIGH_VALUE_XOF", 10_000_000),
  AML_STRUCTURING_XOF:     env("AML_STRUCTURING_XOF", 9_500_000),
  AML_STRUCTURING_TX_24H:  env("AML_STRUCTURING_TX_24H", 3),
  AML_VELOCITY_WINDOW_MIN: env("AML_VELOCITY_WINDOW_MIN", 60),
  AML_VELOCITY_MAX_TX:     env("AML_VELOCITY_MAX_TX", 30),
  DEDUP_WINDOW_HOURS:      env("RISK_DEDUP_WINDOW_HOURS", 24),
  // KYC level from which critical-value transfers are allowed to proceed (still flagged).
  CRITICAL_VALUE_MIN_KYC:  env("FRAUD_CRITICAL_VALUE_MIN_KYC", 2),
};

const PEGGED_TO_XOF = new Set(["XOF", "XAF"]);

export async function normalizeToXof(amount: number, currency: string): Promise<number | null> {
  if (PEGGED_TO_XOF.has(currency)) return amount;
  try {
    return amount * (await getRate(currency, "XOF"));
  } catch {
    try {
      const inverse = await getRate("XOF", currency);
      return inverse > 0 ? amount / inverse : null;
    } catch {
      return null;
    }
  }
}

async function countOutgoingSince(walletId: string, since: Date): Promise<number> {
  const [row] = await db.select({ cnt: sql<number>`COUNT(*)` })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.fromWalletId, walletId), gte(transactionsTable.createdAt, since)));
  return Number(row?.cnt ?? 0);
}

async function countActivitySince(walletId: string, since: Date): Promise<number> {
  const [row] = await db.select({ cnt: sql<number>`COUNT(*)` })
    .from(transactionsTable)
    .where(and(
      or(eq(transactionsTable.fromWalletId, walletId), eq(transactionsTable.toWalletId, walletId)),
      gte(transactionsTable.createdAt, since),
    ));
  return Number(row?.cnt ?? 0);
}

async function walletKycLevel(walletId: string): Promise<number> {
  const [row] = await db.select({ kycLevel: usersTable.kycLevel })
    .from(walletsTable)
    .innerJoin(usersTable, eq(walletsTable.userId, usersTable.id))
    .where(eq(walletsTable.id, walletId))
    .limit(1);
  return row?.kycLevel ?? 0;
}

async function hasOpenRiskAlert(walletId: string, alertType: string): Promise<boolean> {
  const since = new Date(Date.now() - CONFIG.DEDUP_WINDOW_HOURS * 3600_000);
  const [row] = await db.select({ id: riskAlertsTable.id }).from(riskAlertsTable)
    .where(and(
      eq(riskAlertsTable.walletId, walletId),
      eq(riskAlertsTable.alertType, alertType),
      eq(riskAlertsTable.resolved, false),
      gte(riskAlertsTable.createdAt, since),
    ))
    .limit(1);
  return !!row;
}

async function hasOpenAmlFlag(walletId: string, reason: string): Promise<boolean> {
  const since = new Date(Date.now() - CONFIG.DEDUP_WINDOW_HOURS * 3600_000);
  const [row] = await db.select({ id: amlFlagsTable.id }).from(amlFlagsTable)
    .where(and(
      eq(amlFlagsTable.walletId, walletId),
      eq(amlFlagsTable.reason, reason),
      eq(amlFlagsTable.reviewed, false),
      gte(amlFlagsTable.createdAt, since),
    ))
    .limit(1);
  return !!row;
}

async function persistRiskAlert(input: ScreeningInput, finding: ScreeningFinding, normalizedXof: number | null): Promise<void> {
  const alertId = generateId();
  const metadata = {
    transactionId: input.transactionId,
    transferAmount: input.amount,
    currency: input.currency,
    normalizedXof,
    kind: input.kind,
    reason: finding.reason,
    blocking: finding.blocking,
  };
  await db.insert(riskAlertsTable).values({ id: alertId, walletId: input.walletId, alertType: finding.type, severity: finding.severity, metadata });
  await eventBus.publish("fraud.alert.triggered", {
    alertId, walletId: input.walletId, alertType: finding.type, severity: finding.severity, metadata, timestamp: new Date().toISOString(),
  });
  await audit({ action: "fraud.alert.created", entity: "risk_alert", entityId: alertId,
    metadata: { walletId: input.walletId, alertType: finding.type, severity: finding.severity, blocking: finding.blocking } });
  console.warn(`[RiskScreening] ${finding.blocking ? "BLOCK" : "ALERT"} ${finding.severity.toUpperCase()} | ${finding.type} | wallet=${input.walletId}`);
}

async function persistAmlFlag(input: ScreeningInput, finding: ScreeningFinding, caseType: string, normalizedXof: number | null): Promise<void> {
  const flagId = generateId();
  await db.insert(amlFlagsTable).values({
    id: flagId,
    walletId: input.walletId,
    transactionId: input.transactionId,
    reason: finding.type,
    severity: finding.severity,
    metadata: { amount: input.amount, currency: input.currency, normalizedXof, kind: input.kind, blocking: finding.blocking } as any,
  });

  // One open case per wallet and case type; new flags attach to it instead of spawning duplicates.
  const [openCase] = await db.select({ id: complianceCasesTable.id }).from(complianceCasesTable)
    .where(and(eq(complianceCasesTable.walletId, input.walletId), eq(complianceCasesTable.caseType, caseType), eq(complianceCasesTable.status, "open")))
    .limit(1);
  if (!openCase) {
    await db.insert(complianceCasesTable).values({
      id: generateId(),
      walletId: input.walletId,
      caseType,
      severity: finding.severity,
      status: "open",
      details: { flagId, transactionId: input.transactionId, amount: input.amount, currency: input.currency, normalizedXof, reason: finding.type } as any,
    });
  }

  await eventBus.publish("compliance.alert", { walletId: input.walletId, transactionId: input.transactionId, reason: finding.type, severity: finding.severity });
  await eventBus.publish("transaction.flagged", { transactionId: input.transactionId, walletId: input.walletId, reason: finding.type });
  await messageQueue.produce(MESSAGE_TOPICS.COMPLIANCE, {
    event: "aml.flag", walletId: input.walletId, transactionId: input.transactionId,
    reason: finding.type, severity: finding.severity, caseType, blocking: finding.blocking,
  }).catch((err) => console.error("[RiskScreening] compliance queue produce failed:", err));
  console.log(`[AML] ${finding.blocking ? "BLOCK" : "FLAG"} ${finding.severity.toUpperCase()} | ${finding.type} | wallet=${input.walletId}`);
}

// Runs before any money moves. Findings are persisted (deduplicated over a 24h window)
// and the decision is returned to the caller, which must refuse the operation on "block".
export async function screenTransaction(input: ScreeningInput): Promise<ScreeningResult> {
  const findings: ScreeningFinding[] = [];
  const normalizedXof = await normalizeToXof(input.amount, input.currency);
  const xof = normalizedXof ?? input.amount;
  const outgoing = input.kind !== "deposit";
  const now = Date.now();

  // ── Fraud rules (outgoing, customer-initiated) ───────────────────────────────
  if (outgoing && !input.internal) {
    const rapidCount = await countOutgoingSince(input.walletId, new Date(now - CONFIG.RAPID_WINDOW_SEC * 1000));
    if (rapidCount >= CONFIG.RAPID_ALERT_COUNT) {
      const blocking = rapidCount >= CONFIG.RAPID_BLOCK_COUNT;
      findings.push({ engine: "fraud", type: "rapid_transfers", severity: blocking ? "critical" : "high",
        reason: `${rapidCount} outgoing transactions in the last ${CONFIG.RAPID_WINDOW_SEC}s`, blocking, deduplicated: false });
    }

    if (xof >= CONFIG.HIGH_VALUE_XOF) {
      const critical = xof >= CONFIG.CRITICAL_VALUE_XOF;
      const kycLevel = critical ? await walletKycLevel(input.walletId) : 0;
      const blocking = critical && kycLevel < CONFIG.CRITICAL_VALUE_MIN_KYC;
      findings.push({ engine: "fraud", type: "high_value_transfer", severity: critical ? "critical" : "high",
        reason: `${input.amount} ${input.currency} (≈${Math.round(xof)} XOF) exceeds the high-value threshold${blocking ? ` and KYC level ${kycLevel} is below ${CONFIG.CRITICAL_VALUE_MIN_KYC}` : ""}`,
        blocking, deduplicated: false });
    }

    const [wallet] = await db.select({ balance: walletsTable.balance }).from(walletsTable).where(eq(walletsTable.id, input.walletId));
    const balance = Number(wallet?.balance ?? 0);
    if (balance > 0 && input.amount / balance >= CONFIG.DRAIN_PCT && xof >= CONFIG.HIGH_VALUE_XOF / 10) {
      findings.push({ engine: "fraud", type: "wallet_draining", severity: "high",
        reason: `Transaction is ${Math.round((input.amount / balance) * 100)}% of wallet balance`, blocking: false, deduplicated: false });
    }
  }

  // ── AML rules (every flow, both directions) ──────────────────────────────────
  const amlCase: Record<string, string> = {};
  if (xof >= CONFIG.AML_HIGH_VALUE_XOF) {
    findings.push({ engine: "aml", type: "high_value_transaction", severity: "high",
      reason: `≈${Math.round(xof)} XOF meets the high-value reporting threshold`, blocking: false, deduplicated: false });
    amlCase.high_value_transaction = "high_value_reporting";
  } else if (xof >= CONFIG.AML_STRUCTURING_XOF) {
    const cnt = await countActivitySince(input.walletId, new Date(now - 24 * 3600_000));
    if (cnt >= CONFIG.AML_STRUCTURING_TX_24H) {
      findings.push({ engine: "aml", type: "structuring_detected", severity: "critical",
        reason: `${cnt} transactions just under the reporting threshold within 24h`, blocking: true, deduplicated: false });
      amlCase.structuring_detected = "structuring";
    }
  }
  if (!input.internal) {
    const velocity = await countActivitySince(input.walletId, new Date(now - CONFIG.AML_VELOCITY_WINDOW_MIN * 60_000));
    if (velocity >= CONFIG.AML_VELOCITY_MAX_TX) {
      findings.push({ engine: "aml", type: "unusual_velocity", severity: "high",
        reason: `${velocity} transactions in the last ${CONFIG.AML_VELOCITY_WINDOW_MIN} minutes`, blocking: false, deduplicated: false });
      amlCase.unusual_velocity = "transaction_monitoring";
    }
  }

  // ── Persist (deduplicated) ───────────────────────────────────────────────────
  for (const finding of findings) {
    try {
      if (finding.engine === "fraud") {
        if (await hasOpenRiskAlert(input.walletId, finding.type)) { finding.deduplicated = true; continue; }
        await persistRiskAlert(input, finding, normalizedXof);
      } else {
        if (await hasOpenAmlFlag(input.walletId, finding.type)) { finding.deduplicated = true; continue; }
        await persistAmlFlag(input, finding, amlCase[finding.type] ?? "transaction_monitoring", normalizedXof);
      }
    } catch (err) {
      console.error("[RiskScreening] Failed to persist finding:", err);
    }
  }

  const decision = findings.some(f => f.blocking) ? "block" : "allow";
  if (decision === "block") {
    await audit({ action: "transaction.blocked", entity: "wallet", entityId: input.walletId,
      metadata: { transactionId: input.transactionId, kind: input.kind, amount: input.amount, currency: input.currency,
        reasons: findings.filter(f => f.blocking).map(f => f.type) } });
  }
  return { decision, findings, normalizedXof };
}

export async function assertTransactionAllowed(input: ScreeningInput): Promise<ScreeningResult> {
  const result = await screenTransaction(input);
  if (result.decision === "block") throw new TransactionBlockedError(result.findings);
  return result;
}
