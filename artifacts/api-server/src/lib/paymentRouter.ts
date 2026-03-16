import { db } from "@workspace/db";
import { paymentRoutesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { generateId } from "./id";

export type RouteType =
  | "internal_transfer"
  | "bank_settlement"
  | "mobile_money"
  | "merchant_payment"
  | "international_wire"
  | "card_payment";

export interface RouteDecision {
  routeType: RouteType;
  processor: string;
  priority:  number;
  config:    Record<string, unknown>;
}

export interface PaymentContext {
  amount:       number;
  currency:     string;
  fromWalletId: string;
  toWalletId?:  string;
  merchantId?:  string;
  partnerId?:   string;
  metadata?:    Record<string, unknown>;
}

class PaymentRoutingEngine {
  async selectRoute(ctx: PaymentContext): Promise<RouteDecision> {
    const routes = await db.select()
      .from(paymentRoutesTable)
      .where(eq(paymentRoutesTable.active, true))
      .orderBy(asc(paymentRoutesTable.priority));

    for (const route of routes) {
      const cfg = (route.config ?? {}) as Record<string, unknown>;

      if (route.routeType === "internal_transfer" && ctx.toWalletId && !ctx.merchantId) {
        return { routeType: "internal_transfer", processor: route.processor, priority: route.priority, config: cfg };
      }
      if (route.routeType === "merchant_payment" && ctx.merchantId) {
        return { routeType: "merchant_payment", processor: route.processor, priority: route.priority, config: cfg };
      }
      if (route.routeType === "mobile_money" && ctx.partnerId) {
        return { routeType: "mobile_money", processor: route.processor, priority: route.priority, config: cfg };
      }
      if (route.routeType === "bank_settlement" && ctx.amount >= 1_000_000) {
        return { routeType: "bank_settlement", processor: route.processor, priority: route.priority, config: cfg };
      }
      if (route.routeType === "international_wire" && ctx.currency !== "XOF") {
        return { routeType: "international_wire", processor: route.processor, priority: route.priority, config: cfg };
      }
    }

    return {
      routeType: "internal_transfer",
      processor: "kowri_internal",
      priority:  999,
      config:    {},
    };
  }

  async seedDefaultRoutes(): Promise<void> {
    const existing = await db.select().from(paymentRoutesTable).limit(1);
    if (existing.length > 0) return;

    const defaults: Array<{
      id: string;
      routeType: string;
      processor: string;
      priority: number;
      active: boolean;
      config: Record<string, unknown>;
    }> = [
      { id: generateId(), routeType: "internal_transfer",  processor: "kowri_internal",   priority: 10,  active: true, config: { maxAmount: 999999999 } },
      { id: generateId(), routeType: "merchant_payment",   processor: "kowri_merchant",    priority: 20,  active: true, config: { feePercent: 0.5 } },
      { id: generateId(), routeType: "mobile_money",       processor: "orange_money",      priority: 30,  active: true, config: { partner: "orange", maxAmount: 5000000 } },
      { id: generateId(), routeType: "mobile_money",       processor: "wave_money",        priority: 31,  active: true, config: { partner: "wave", maxAmount: 10000000 } },
      { id: generateId(), routeType: "bank_settlement",    processor: "bank_of_dakar",     priority: 40,  active: true, config: { settlementCutoff: "16:00", currency: "XOF" } },
      { id: generateId(), routeType: "international_wire", processor: "swift_connector",   priority: 50,  active: true, config: { network: "SWIFT", correspondent: "SGBFFRPP" } },
      { id: generateId(), routeType: "card_payment",       processor: "visa_direct",       priority: 60,  active: true, config: { network: "VISA", region: "WAEMU" } },
    ];

    await db.insert(paymentRoutesTable).values(defaults);
    console.log("[PaymentRouter] Seeded", defaults.length, "default routes");
  }
}

export const paymentRouter = new PaymentRoutingEngine();
