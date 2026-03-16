import { MessageConsumer, MessageProducer, MESSAGE_TOPICS } from "../lib/messageQueue";
import { tracer } from "../lib/tracer";

const ledgerConsumer = new MessageConsumer("ledger-service");
ledgerConsumer.on(MESSAGE_TOPICS.TRANSACTIONS, async (msg) => {
  await tracer.trace("ledger-service", "process_transaction", async () => {
    console.log(`[LedgerService] Processing tx event: ${msg.payload.txId ?? msg.payload.event}`);
  });
});

const fraudConsumer = new MessageConsumer("fraud-service");
fraudConsumer.on(MESSAGE_TOPICS.FRAUD_ALERTS, async (msg) => {
  await tracer.trace("fraud-service", "process_fraud_alert", async () => {
    console.log(`[FraudService] Alert: ${msg.payload.reason} severity=${msg.payload.severity}`);
  });
});

const settlementConsumer = new MessageConsumer("settlement-service");
settlementConsumer.on(MESSAGE_TOPICS.SETTLEMENTS, async (msg) => {
  await tracer.trace("settlement-service", "process_settlement", async () => {
    console.log(`[SettlementService] Event: ${msg.payload.event}`);
  });
});

const analyticsConsumer = new MessageConsumer("analytics-service");
analyticsConsumer.on(MESSAGE_TOPICS.LEDGER_EVENTS, async (msg) => {
  await tracer.trace("analytics-service", "process_ledger_event", async () => {
    console.log(`[AnalyticsService] Ledger event: ${msg.payload.event}`);
  });
});

const notificationConsumer = new MessageConsumer("notification-service");
notificationConsumer.on(MESSAGE_TOPICS.NOTIFICATIONS, async (msg) => {
  await tracer.trace("notification-service", "send_notification", async () => {
    console.log(`[NotificationService] Notify: ${msg.payload.event}`);
  });
});

const complianceConsumer = new MessageConsumer("compliance-service");
complianceConsumer.on(MESSAGE_TOPICS.COMPLIANCE, async (msg) => {
  await tracer.trace("compliance-service", "process_compliance_event", async () => {
    console.log(`[ComplianceService] AML: ${msg.payload.reason} severity=${msg.payload.severity}`);
  });
});

export const walletProducer    = new MessageProducer(MESSAGE_TOPICS.WALLET_UPDATES);
export const ledgerProducer    = new MessageProducer(MESSAGE_TOPICS.LEDGER_EVENTS);
export const txProducer        = new MessageProducer(MESSAGE_TOPICS.TRANSACTIONS);
export const fraudProducer     = new MessageProducer(MESSAGE_TOPICS.FRAUD_ALERTS);
export const settlementProducer = new MessageProducer(MESSAGE_TOPICS.SETTLEMENTS);
export const notifyProducer    = new MessageProducer(MESSAGE_TOPICS.NOTIFICATIONS);

export const SERVICES = [
  "ledger-service",
  "wallet-service",
  "payment-service",
  "fraud-service",
  "settlement-service",
  "analytics-service",
  "notification-service",
  "compliance-service",
] as const;

console.log("[Microservices] All service consumers registered:", SERVICES.join(", "));
