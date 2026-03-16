import { db } from "@workspace/db";
import { settlementsTable } from "@workspace/db";
import { eq, desc, count } from "drizzle-orm";
import { generateId } from "./id";
import { eventBus } from "./eventBus";
import { audit as auditLog } from "./auditLogger";

export type SettlementStatus = "pending" | "processing" | "settled" | "failed";

export async function createSettlement(
  partner: string,
  amount: number,
  currency: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  const id = generateId();

  await db.insert(settlementsTable).values({
    id,
    partner,
    amount: String(amount),
    currency,
    status: "pending",
    metadata: metadata ?? null,
  });

  await auditLog({
    action: "settlement.created",
    entity: "settlement",
    entityId: id,
    metadata: { partner, amount, currency },
  });

  await eventBus.publish("settlement.started", { settlementId: id, partner, amount, currency });

  return id;
}

export async function processSettlement(settlementId: string): Promise<void> {
  const [settlement] = await db.select().from(settlementsTable).where(eq(settlementsTable.id, settlementId));
  if (!settlement) throw new Error(`Settlement ${settlementId} not found`);
  if (settlement.status !== "pending") throw new Error(`Settlement ${settlementId} is ${settlement.status}`);

  await db.update(settlementsTable).set({ status: "processing" }).where(eq(settlementsTable.id, settlementId));

  await new Promise((r) => setTimeout(r, 50));

  try {
    await db
      .update(settlementsTable)
      .set({ status: "settled", settledAt: new Date() })
      .where(eq(settlementsTable.id, settlementId));

    await auditLog({
      action: "settlement.completed",
      entity: "settlement",
      entityId: settlementId,
      metadata: { partner: settlement.partner, amount: settlement.amount, currency: settlement.currency },
    });

    await eventBus.publish("settlement.completed", {
      settlementId,
      partner: settlement.partner,
      amount: settlement.amount,
      currency: settlement.currency,
    });
  } catch (err: unknown) {
    await db.update(settlementsTable).set({ status: "failed" }).where(eq(settlementsTable.id, settlementId));
    throw err;
  }
}

export async function getSettlements(limit = 20, offset = 0) {
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(settlementsTable).orderBy(desc(settlementsTable.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(settlementsTable),
  ]);
  return { settlements: rows.map((r) => ({ ...r, amount: Number(r.amount) })), total: Number(total) };
}
