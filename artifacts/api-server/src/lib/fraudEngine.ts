import { db } from "@workspace/db";
import { riskAlertsTable } from "@workspace/db";
import { transactionsTable, walletsTable } from "@workspace/db";
import { eq, gte, sql, and } from "drizzle-orm";
import { generateId } from "./id";
import { eventBus } from "./eventBus";
import { audit as auditLog } from "./auditLogger";

export type AlertSeverity = "low" | "medium" | "high" | "critical";
export type AlertType =
  | "rapid_transfers"
  | "high_value_transfer"
  | "wallet_draining"
  | "unusual_pattern"
  | "burst_activity";

const CONFIG = {
  RAPID_TRANSFER_WINDOW_SEC: 30,
  RAPID_TRANSFER_COUNT: 5,
  HIGH_VALUE_THRESHOLD_XOF: 1_000_000,
  DRAIN_THRESHOLD_PCT: 0.80,
};

async function createAlert(
  walletId: string,
  alertType: AlertType,
  severity: AlertSeverity,
  metadata: Record<string, unknown>
): Promise<void> {
  const alertId = generateId();
  await db.insert(riskAlertsTable).values({ id: alertId, walletId, alertType, severity, metadata });

  await eventBus.publish("fraud.alert.triggered", {
    alertId,
    walletId,
    alertType,
    severity,
    metadata,
    timestamp: new Date().toISOString(),
  });

  await auditLog({
    action: "fraud.alert.created",
    entity: "risk_alert",
    entityId: alertId,
    metadata: { walletId, alertType, severity },
  });

  console.warn(`[FraudEngine] ALERT ${severity.toUpperCase()} | ${alertType} | wallet=${walletId}`);
}

export interface FraudCheckResult {
  passed: boolean;
  alerts: Array<{ type: AlertType; severity: AlertSeverity; reason: string }>;
}

export async function runFraudCheck(
  walletId: string,
  transferAmount: number,
  currency: string
): Promise<FraudCheckResult> {
  const alerts: Array<{ type: AlertType; severity: AlertSeverity; reason: string }> = [];

  try {
    const windowStart = new Date(Date.now() - CONFIG.RAPID_TRANSFER_WINDOW_SEC * 1000);
    const [recentCount] = await db
      .select({ cnt: sql<number>`COUNT(*)` })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.fromWalletId, walletId),
          gte(transactionsTable.createdAt, windowStart)
        )
      );

    const txCount = Number(recentCount?.cnt ?? 0);
    if (txCount >= CONFIG.RAPID_TRANSFER_COUNT) {
      alerts.push({
        type: "rapid_transfers",
        severity: txCount >= 10 ? "critical" : "high",
        reason: `${txCount} transfers in last ${CONFIG.RAPID_TRANSFER_WINDOW_SEC}s`,
      });
    }

    const normAmount = currency === "XOF" || currency === "XAF" ? transferAmount : transferAmount * 609.76;
    if (normAmount >= CONFIG.HIGH_VALUE_THRESHOLD_XOF) {
      alerts.push({
        type: "high_value_transfer",
        severity: normAmount >= 5_000_000 ? "critical" : "high",
        reason: `Transfer of ${transferAmount} ${currency} exceeds threshold`,
      });
    }

    const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, walletId));
    if (wallet) {
      const balance = Number(wallet.balance);
      if (balance > 0 && transferAmount / balance >= CONFIG.DRAIN_THRESHOLD_PCT) {
        alerts.push({
          type: "wallet_draining",
          severity: "high",
          reason: `Transfer is ${Math.round((transferAmount / balance) * 100)}% of wallet balance`,
        });
      }
    }

    for (const alert of alerts) {
      await createAlert(walletId, alert.type, alert.severity, {
        transferAmount,
        currency,
        reason: alert.reason,
      });
    }
  } catch (err) {
    console.error("[FraudEngine] Check failed:", err);
  }

  return { passed: true, alerts };
}

export async function getRiskAlerts(walletId?: string, limit = 50, offset = 0) {
  const query = db.select().from(riskAlertsTable);
  if (walletId) {
    return query.where(eq(riskAlertsTable.walletId, walletId)).limit(limit).offset(offset);
  }
  return query.limit(limit).offset(offset);
}
