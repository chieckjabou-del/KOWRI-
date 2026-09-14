import { db } from "@workspace/db";
import { riskAlertsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { screenTransaction, type ScreeningFinding, type Severity } from "./riskScreening";
import { generateId } from "./id";

export type AlertSeverity = Severity;
export type AlertType =
  | "rapid_transfers"
  | "high_value_transfer"
  | "wallet_draining"
  | "unusual_pattern"
  | "burst_activity";

export interface FraudCheckResult {
  passed: boolean;
  alerts: Array<{ type: string; severity: AlertSeverity; reason: string; blocking: boolean }>;
}

// Thin wrapper kept for callers that evaluate a wallet outside the ledger path
// (admin tooling, replays). The ledger itself uses riskScreening before commit.
export async function runFraudCheck(
  walletId: string,
  transferAmount: number,
  currency: string,
  opts: { internal?: boolean } = {}
): Promise<FraudCheckResult> {
  const result = await screenTransaction({
    walletId,
    transactionId: `adhoc-${generateId()}`,
    amount: transferAmount,
    currency,
    kind: "transfer",
    internal: opts.internal,
  });
  const alerts = result.findings
    .filter((f: ScreeningFinding) => f.engine === "fraud")
    .map((f) => ({ type: f.type, severity: f.severity, reason: f.reason, blocking: f.blocking }));
  return { passed: result.decision === "allow", alerts };
}

export async function getRiskAlerts(walletId?: string, limit = 50, offset = 0) {
  const query = db.select().from(riskAlertsTable).orderBy(desc(riskAlertsTable.createdAt));
  if (walletId) {
    return query.where(eq(riskAlertsTable.walletId, walletId)).limit(limit).offset(offset);
  }
  return query.limit(limit).offset(offset);
}
