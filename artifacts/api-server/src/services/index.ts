import { MessageConsumer, MessageProducer, MESSAGE_TOPICS } from "../lib/messageQueue";
import { tracer } from "../lib/tracer";
import { eventBus } from "../lib/eventBus";
import { db } from "@workspace/db";
import { productNotificationsTable, walletsTable } from "@workspace/db";
import { generateId } from "../lib/id";
import { eq } from "drizzle-orm";

// ── helpers ────────────────────────────────────────────────────────────────────

function fmtAmount(amount: unknown, currency?: unknown): string {
  const n = Number(amount);
  const cur = String(currency ?? "XOF");
  return isNaN(n) ? `${amount} ${cur}` : `${n.toLocaleString("fr-FR")} ${cur}`;
}

async function insertNotification(
  userId: string,
  type: string,
  title: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await db.insert(productNotificationsTable).values({
      id:       generateId(),
      userId,
      type,
      title,
      message,
      channel:  "in_app",
      metadata: metadata ?? null,
    });
  } catch (err) {
    console.error("[NotificationService] Insert failed:", err);
  }
}

async function walletOwner(walletId?: unknown): Promise<string | null> {
  if (!walletId) return null;
  const [row] = await db
    .select({ userId: walletsTable.userId })
    .from(walletsTable)
    .where(eq(walletsTable.id, String(walletId)))
    .limit(1);
  return row?.userId ?? null;
}

// ── eventBus real-event listeners ─────────────────────────────────────────────

eventBus.on("transaction.created", async (event) => {
  const { type, amount, currency, fromWalletId, toWalletId, walletId } = event.payload as any;
  const amtStr = fmtAmount(amount, currency);

  if (type === "transfer") {
    const [senderId, receiverId] = await Promise.all([
      walletOwner(fromWalletId),
      walletOwner(toWalletId),
    ]);
    if (senderId) {
      await insertNotification(senderId, "transaction", "Envoi effectué",
        `Vous avez envoyé ${amtStr}`, { txId: event.payload.txId });
    }
    if (receiverId) {
      await insertNotification(receiverId, "transaction", "Argent reçu",
        `Vous avez reçu ${amtStr}`, { txId: event.payload.txId });
    }
  } else {
    const ownerId = await walletOwner(walletId ?? toWalletId);
    if (ownerId) {
      await insertNotification(ownerId, "transaction", "Dépôt reçu",
        `Un dépôt de ${amtStr} a été crédité`, { txId: event.payload.txId });
    }
  }
});

eventBus.on("loan.disbursed", async (event) => {
  const { userId, amount, currency } = event.payload as any;
  if (!userId) return;
  await insertNotification(String(userId), "credit", "Crédit versé",
    `Votre crédit de ${fmtAmount(amount, currency)} a été versé sur votre compte`,
    { loanId: event.payload.loanId });
});

eventBus.on("loan.repayment.made", async (event) => {
  const { userId, amount, isFullyRepaid } = event.payload as any;
  if (!userId) return;
  const title = isFullyRepaid ? "Prêt remboursé !" : "Remboursement enregistré";
  const message = isFullyRepaid
    ? "Félicitations ! Votre prêt est entièrement remboursé."
    : `Remboursement de ${fmtAmount(amount)} enregistré avec succès`;
  await insertNotification(String(userId), "credit", title, message,
    { loanId: event.payload.loanId });
});

eventBus.on("tontine.payout.completed", async (event) => {
  const { recipientId, amount, currency, tontineName, tontineId } = event.payload as any;
  if (!recipientId) return;
  await insertNotification(String(recipientId), "transaction", "Payout reçu !",
    `Vous avez reçu ${fmtAmount(amount, currency)} de votre tontine ${tontineName ?? ""}`.trim(),
    { tontineId });
});

eventBus.on("tontine.contributions.collected", async (event) => {
  const { members, amount, currency, tontineId } = event.payload as any;
  if (!Array.isArray(members)) return;
  await Promise.all(
    members.map((userId: string) =>
      insertNotification(userId, "transaction", "Cotisation collectée",
        `Votre cotisation de ${fmtAmount(amount, currency)} a été prélevée`, { tontineId })
    )
  );
});

// ── Message queue consumers ────────────────────────────────────────────────────

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

// notification-service: handles messages explicitly pushed to the notifications topic
const notificationConsumer = new MessageConsumer("notification-service");
notificationConsumer.on(MESSAGE_TOPICS.NOTIFICATIONS, async (msg) => {
  await tracer.trace("notification-service", "send_notification", async () => {
    const {
      event, userId, recipientId, amount, currency,
      tontineName, members, tontineId,
    } = msg.payload as any;
    const target = (recipientId ?? userId) as string | undefined;
    const amtStr = fmtAmount(amount, currency);

    switch (event) {
      case "tontine.payout.completed":
        if (target) {
          await insertNotification(target, "transaction", "Payout reçu !",
            `Vous avez reçu ${amtStr} de votre tontine ${tontineName ?? ""}`.trim(),
            { tontineId });
        }
        break;

      case "tontine.contributions.collected":
        if (Array.isArray(members)) {
          await Promise.all(members.map((uid: string) =>
            insertNotification(uid, "transaction", "Cotisation collectée",
              `Votre cotisation de ${amtStr} a été prélevée`, { tontineId })
          ));
        }
        break;

      case "transaction.created":
        if (target) {
          await insertNotification(target, "transaction", "Transaction",
            `Transaction de ${amtStr} effectuée`);
        }
        break;

      case "loan.disbursed":
        if (target) {
          await insertNotification(target, "credit", "Crédit versé",
            `Votre crédit de ${amtStr} a été versé`);
        }
        break;

      case "loan.repayment":
        if (target) {
          await insertNotification(target, "credit", "Remboursement enregistré",
            `Remboursement de ${amtStr} enregistré`);
        }
        break;

      default:
        console.log(`[NotificationService] Unhandled MQ event: ${event}`);
    }
  });
});

const complianceConsumer = new MessageConsumer("compliance-service");
complianceConsumer.on(MESSAGE_TOPICS.COMPLIANCE, async (msg) => {
  await tracer.trace("compliance-service", "process_compliance_event", async () => {
    console.log(`[ComplianceService] AML: ${msg.payload.reason} severity=${msg.payload.severity}`);
  });
});

export const walletProducer     = new MessageProducer(MESSAGE_TOPICS.WALLET_UPDATES);
export const ledgerProducer     = new MessageProducer(MESSAGE_TOPICS.LEDGER_EVENTS);
export const txProducer         = new MessageProducer(MESSAGE_TOPICS.TRANSACTIONS);
export const fraudProducer      = new MessageProducer(MESSAGE_TOPICS.FRAUD_ALERTS);
export const settlementProducer = new MessageProducer(MESSAGE_TOPICS.SETTLEMENTS);
export const notifyProducer     = new MessageProducer(MESSAGE_TOPICS.NOTIFICATIONS);

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
