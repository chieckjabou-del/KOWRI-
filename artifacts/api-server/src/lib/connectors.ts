import { db } from "@workspace/db";
import { connectorsTable, settlementsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { generateId } from "./id";
import { eventBus } from "./eventBus";
import { messageQueue, MESSAGE_TOPICS } from "./messageQueue";

export interface PaymentRequest {
  id:        string;
  amount:    number;
  currency:  string;
  reference: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentResult {
  success:     boolean;
  externalRef: string;
  status:      "initiated" | "confirmed" | "failed";
  message?:    string;
  durationMs:  number;
}

export interface BankConnector {
  name:                 string;
  connectorType:        string;
  initiatePayment(req:  PaymentRequest): Promise<PaymentResult>;
  confirmPayment(ref:   string):         Promise<PaymentResult>;
  reconcileSettlement(settlementId: string): Promise<{ reconciled: boolean; discrepancy: number }>;
}

class BankTransferConnector implements BankConnector {
  name          = "Bank Transfer";
  connectorType = "bank_transfer";

  async initiatePayment(req: PaymentRequest): Promise<PaymentResult> {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    const externalRef = `BT-${Date.now()}-${req.id.slice(0, 8)}`;
    await messageQueue.produce(MESSAGE_TOPICS.SETTLEMENTS, {
      event:       "payment.initiated",
      connector:   this.name,
      reference:   req.reference,
      externalRef,
      amount:      req.amount,
      currency:    req.currency,
    });
    return { success: true, externalRef, status: "initiated", durationMs: Date.now() - start };
  }

  async confirmPayment(ref: string): Promise<PaymentResult> {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    return { success: true, externalRef: ref, status: "confirmed", durationMs: Date.now() - start };
  }

  async reconcileSettlement(settlementId: string): Promise<{ reconciled: boolean; discrepancy: number }> {
    const [row] = await db.select().from(settlementsTable).where(eq(settlementsTable.id, settlementId));
    if (!row) return { reconciled: false, discrepancy: 0 };
    await eventBus.publish("settlement.reconciled", { settlementId, partner: row.partner, amount: row.amount });
    return { reconciled: true, discrepancy: 0 };
  }
}

class MobileMoneyConnector implements BankConnector {
  name          = "Mobile Money";
  connectorType = "mobile_money";

  async initiatePayment(req: PaymentRequest): Promise<PaymentResult> {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 15));
    const externalRef = `MM-${Date.now()}-${req.id.slice(0, 8)}`;
    await messageQueue.produce(MESSAGE_TOPICS.NOTIFICATIONS, {
      event:     "mobile_money.initiated",
      reference: req.reference,
      externalRef,
      amount:    req.amount,
    });
    return { success: true, externalRef, status: "initiated", durationMs: Date.now() - start };
  }

  async confirmPayment(ref: string): Promise<PaymentResult> {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    return { success: true, externalRef: ref, status: "confirmed", durationMs: Date.now() - start };
  }

  async reconcileSettlement(settlementId: string): Promise<{ reconciled: boolean; discrepancy: number }> {
    return { reconciled: true, discrepancy: 0 };
  }
}

class CardProcessorConnector implements BankConnector {
  name          = "Card Processor";
  connectorType = "card_processor";

  async initiatePayment(req: PaymentRequest): Promise<PaymentResult> {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 25));
    const externalRef = `CARD-${Date.now()}-${req.id.slice(0, 8)}`;
    return { success: true, externalRef, status: "initiated", durationMs: Date.now() - start };
  }

  async confirmPayment(ref: string): Promise<PaymentResult> {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    return { success: true, externalRef: ref, status: "confirmed", durationMs: Date.now() - start };
  }

  async reconcileSettlement(settlementId: string): Promise<{ reconciled: boolean; discrepancy: number }> {
    return { reconciled: true, discrepancy: 0 };
  }
}

export const connectorRegistry: Record<string, BankConnector> = {
  bank_transfer: new BankTransferConnector(),
  mobile_money:  new MobileMoneyConnector(),
  card_processor: new CardProcessorConnector(),
};

export async function seedConnectors(): Promise<void> {
  const existing = await db.select().from(connectorsTable).limit(1);
  if (existing.length > 0) return;

  await db.insert(connectorsTable).values([
    { id: generateId(), name: "Bank Transfer",   connectorType: "bank_transfer",  active: true, config: { timeout: 30000, retries: 3 } as any },
    { id: generateId(), name: "Orange Money",    connectorType: "mobile_money",   active: true, config: { partner: "orange", apiUrl: "https://api.orange.sn" } as any },
    { id: generateId(), name: "Wave",            connectorType: "mobile_money",   active: true, config: { partner: "wave", apiUrl: "https://api.wave.com" } as any },
    { id: generateId(), name: "Visa Direct",     connectorType: "card_processor", active: true, config: { network: "VISA", region: "WAEMU" } as any },
    { id: generateId(), name: "Mastercard Send", connectorType: "card_processor", active: true, config: { network: "MC", region: "WAEMU" } as any },
  ]);
  console.log("[Connectors] Seeded 5 connectors");
}
