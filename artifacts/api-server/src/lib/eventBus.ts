import { EventEmitter } from "events";
import { db } from "@workspace/db";
import { eventLogTable } from "@workspace/db";
import { generateId } from "./id";
import { recordMetric } from "./metrics";

export type KowriEventType =
  | "transaction.created"
  | "wallet.balance.updated"
  | "loan.disbursed"
  | "tontine.contribution"
  | "merchant.payment.completed";

export interface KowriEvent {
  type: KowriEventType;
  payload: Record<string, unknown>;
  timestamp: Date;
}

class KowriEventBus extends EventEmitter {
  async publish(type: KowriEventType, payload: Record<string, unknown>): Promise<void> {
    const event: KowriEvent = { type, payload, timestamp: new Date() };
    const start = Date.now();

    this.emit(type, event);
    this.emit("*", event);

    try {
      await db.insert(eventLogTable).values({
        id: generateId(),
        eventType: type,
        payload: payload as any,
      });
    } catch (err) {
      console.error("[EventBus] Failed to persist event:", type, err);
    }

    recordMetric("event", Date.now() - start, type);
  }
}

export const eventBus = new KowriEventBus();
eventBus.setMaxListeners(50);

eventBus.on("transaction.created", (event: KowriEvent) => {
  const { txId, type, amount, currency } = event.payload;
  console.log(`[WalletService] Tx created: ${txId} | ${type} | ${amount} ${currency}`);
});

eventBus.on("wallet.balance.updated", (event: KowriEvent) => {
  const { walletId, newBalance, currency } = event.payload;
  console.log(`[NotificationService] Balance updated: wallet=${walletId} balance=${newBalance} ${currency}`);
});

eventBus.on("loan.disbursed", (event: KowriEvent) => {
  const { loanId, userId, amount } = event.payload;
  console.log(`[NotificationService] Loan disbursed: loan=${loanId} user=${userId} amount=${amount}`);
});

eventBus.on("tontine.contribution", (event: KowriEvent) => {
  const { tontineId, userId, amount } = event.payload;
  console.log(`[AnalyticsEngine] Tontine contribution: tontine=${tontineId} user=${userId} amount=${amount}`);
});

eventBus.on("merchant.payment.completed", (event: KowriEvent) => {
  const { merchantId, amount } = event.payload;
  console.log(`[RiskEngine] Merchant payment: merchant=${merchantId} amount=${amount}`);
});

eventBus.on("*", (event: KowriEvent) => {
  console.log(`[RiskEngine] Screening event: ${event.type}`);
});
