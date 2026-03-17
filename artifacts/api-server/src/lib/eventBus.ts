import { EventEmitter } from "events";
import { db } from "@workspace/db";
import { eventLogTable } from "@workspace/db";
import { generateId } from "./id";
import { recordMetric } from "./metrics";
import { eventBusCircuitBreaker } from "./circuitBreaker";

export type KowriEventType =
  | "transaction.created"
  | "wallet.balance.updated"
  | "loan.disbursed"
  | "tontine.contribution"
  | "merchant.payment.completed"
  | "fraud.alert.triggered"
  | "settlement.started"
  | "settlement.completed";

export interface KowriEvent {
  type: KowriEventType | string;
  payload: Record<string, unknown>;
  timestamp: Date;
}

interface BufferedEvent {
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  firstFailedAt: Date;
}

const fallbackBuffer: BufferedEvent[] = [];
const BUFFER_MAX       = 5_000;
const BUFFER_MAX_AGE_MS = 10 * 60 * 1000;
const DRAIN_INTERVAL_MS = 15_000;
const MAX_EVENT_ATTEMPTS = 5;

async function persistEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  await eventBusCircuitBreaker.call(() =>
    db.insert(eventLogTable).values({
      id:        generateId(),
      eventType: type,
      payload:   payload as any,
    })
  );
}

async function drainBuffer(): Promise<void> {
  if (fallbackBuffer.length === 0) return;

  const now = Date.now();
  const toRetry = fallbackBuffer.splice(0, 100);

  for (const evt of toRetry) {
    if (evt.attempts >= MAX_EVENT_ATTEMPTS) continue;
    if (now - evt.firstFailedAt.getTime() > BUFFER_MAX_AGE_MS) continue;

    try {
      await persistEvent(evt.type, evt.payload);
    } catch {
      evt.attempts++;
      if (evt.attempts < MAX_EVENT_ATTEMPTS) {
        fallbackBuffer.push(evt);
      }
    }
  }
}

setInterval(drainBuffer, DRAIN_INTERVAL_MS).unref();

class KowriEventBus extends EventEmitter {
  async publish(type: KowriEventType | string, payload: Record<string, unknown>): Promise<void> {
    const event: KowriEvent = { type, payload, timestamp: new Date() };
    const start = Date.now();

    this.emit(type, event);
    this.emit("*", event);

    try {
      await persistEvent(type, payload);
    } catch (err) {
      console.error("[EventBus] DB write failed — buffering event:", type, err);
      if (fallbackBuffer.length < BUFFER_MAX) {
        fallbackBuffer.push({ type, payload, attempts: 1, firstFailedAt: new Date() });
      } else {
        console.error("[EventBus] Buffer full — event dropped:", type);
      }
    }

    setImmediate(async () => {
      try {
        const { dispatchWebhooks } = await import("./webhookDispatcher");
        await dispatchWebhooks(type as any, payload);
      } catch (_) {}
    });

    recordMetric("event", Date.now() - start, type);
  }

  getBufferStats() {
    return {
      bufferedEvents: fallbackBuffer.length,
      bufferMax:      BUFFER_MAX,
      circuitBreaker: eventBusCircuitBreaker.getStats(),
    };
  }
}

export const eventBus = new KowriEventBus();
eventBus.setMaxListeners(100);

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

eventBus.on("fraud.alert.triggered", (event: KowriEvent) => {
  const { alertType, severity, walletId } = event.payload;
  console.warn(`[FraudEngine] ALERT ${severity?.toString().toUpperCase()} | ${alertType} | wallet=${walletId}`);
});

eventBus.on("settlement.started", (event: KowriEvent) => {
  console.log(`[Settlement] Started: ${event.payload.settlementId} partner=${event.payload.partner}`);
});

eventBus.on("settlement.completed", (event: KowriEvent) => {
  console.log(`[Settlement] Completed: ${event.payload.settlementId}`);
});

eventBus.on("*", (event: KowriEvent) => {
  console.log(`[EventBus] ${event.type}`);
});
