import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db";
import { generateId } from "./id";

export type AuditAction =
  | "transaction.created"
  | "transaction.state_changed"
  | "ledger.entry_written"
  | "wallet.balance_synced"
  | "wallet_dormant"
  | "reconciliation.run"
  | "reconciliation.fixed"
  | "admin.patch_tontines"
  | "idempotency.replayed"
  | "fee.applied"
  | "tontine.goal.vendor_claim_expired"
  | "investment.pool.created"
  | "community.created"
  | "remittance.sent"
  | "fraud.alert.created"
  | "saga.started"
  | "saga.step.failed"
  | "saga.completed"
  | "saga.compensated"
  | "savings.plan.created"
  | "savings.plan.matured"
  | "settlement.created"
  | "settlement.completed"
  | "tontine.growth.rate_applied"
  | "tontine_missed_contribution"
  | "tontine.payout.completed"
  | "tontine.hybrid.solidarity_reserve_tagged"
  | "tontine.hybrid.cycle_completed"
  | "strategy_distribution"
  | "tontine.payout.crash_recovery.marked_paid"
  | "tontine.payout.crash_recovery.state_advanced"
  | "tontine.payout.crash_recovery.reset_for_retry"
  | "tontine.goal.pending_vendor_claim";

interface AuditEntry {
  action: AuditAction;
  entity: string;
  entityId: string;
  actor?: string;
  metadata?: Record<string, unknown>;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      id: generateId(),
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      actor: entry.actor ?? "system",
      metadata: (entry.metadata ?? null) as any,
    });
  } catch (err) {
    console.error("[Audit] Failed to write audit log:", err);
  }
}

export async function getAuditTrail(
  entity: string,
  entityId: string,
  limit = 50
): Promise<typeof auditLogsTable.$inferSelect[]> {
  const { eq, desc, and } = await import("drizzle-orm");
  return db
    .select()
    .from(auditLogsTable)
    .where(and(eq(auditLogsTable.entity, entity), eq(auditLogsTable.entityId, entityId)))
    .orderBy(desc(auditLogsTable.timestamp))
    .limit(limit);
}
