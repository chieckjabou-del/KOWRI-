import { screenTransaction, type ScreeningFinding, type Severity } from "./riskScreening";

export type AmlSeverity = Severity;

export interface AmlResult {
  flagged:    boolean;
  reason?:    string;
  severity?:  AmlSeverity;
  caseType?:  string;
  blocking?:  boolean;
}

const CASE_TYPES: Record<string, string> = {
  high_value_transaction: "high_value_reporting",
  structuring_detected:   "structuring",
  unusual_velocity:       "transaction_monitoring",
};

// Kept for the manual /aml/check endpoint and replays; the ledger screens
// every transaction through riskScreening before it commits.
export async function runAmlChecks(
  walletId:      string,
  transactionId: string,
  amount:        number,
  currency:      string,
  opts: { internal?: boolean; kind?: "transfer" | "deposit" | "withdrawal" | "fx_transfer" } = {}
): Promise<AmlResult[]> {
  const result = await screenTransaction({
    walletId, transactionId, amount, currency,
    kind: opts.kind ?? "transfer",
    internal: opts.internal,
  });
  return result.findings
    .filter((f: ScreeningFinding) => f.engine === "aml")
    .map((f) => ({ flagged: true, reason: f.type, severity: f.severity, caseType: CASE_TYPES[f.type] ?? "transaction_monitoring", blocking: f.blocking }));
}
