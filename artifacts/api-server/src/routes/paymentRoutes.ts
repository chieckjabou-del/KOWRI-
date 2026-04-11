import { Router } from "express";
import { db } from "@workspace/db";
import { paymentRoutesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { paymentRouter } from "../lib/paymentRouter";
import { selectOptimal } from "../lib/processorRouter";
import { generateId } from "../lib/id";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";

const router = Router();

const VALID_ROUTE_TYPES = new Set([
  "internal_transfer","bank_settlement","mobile_money",
  "merchant_payment","international_wire","card_payment"
]);

router.get("/", async (_req, res) => {
  try {
    const routes = await db.select().from(paymentRoutesTable).orderBy(asc(paymentRoutesTable.priority));
    return res.json({ routes, total: routes.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch routes" });
  }
});

router.post("/", requireIdempotencyKey, checkIdempotency, async (req, res) => {
  try {
    const { routeType, processor, priority = 100, active = true, config = {} } = req.body;
    if (!routeType || !processor) return res.status(400).json({ error: "routeType and processor are required" });
    if (!VALID_ROUTE_TYPES.has(routeType)) return res.status(400).json({ error: "Invalid routeType" });
    const [route] = await db.insert(paymentRoutesTable).values({
      id: generateId(), routeType, processor, priority, active, config: config as any,
    }).returning();
    return res.status(201).json(route);
  } catch (err) {
    return res.status(500).json({ error: "Failed to create route" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const [updated] = await db.update(paymentRoutesTable)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(paymentRoutesTable.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Route not found" });
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: "Failed to update route" });
  }
});

router.post("/select", async (req, res) => {
  try {
    const { amount, currency, fromWalletId, toWalletId, merchantId, partnerId, strategy, region } = req.body;
    if (!amount || !currency) {
      return res.status(400).json({ error: "amount and currency are required" });
    }

    const processorDecision = selectOptimal({
      strategy: strategy as any,
      currency,
      region: region ?? "africa",
      amount: Number(amount),
    });

    if (fromWalletId) {
      const internalDecision = await paymentRouter.selectRoute({
        amount: Number(amount), currency, fromWalletId, toWalletId, merchantId, partnerId,
      });
      return res.json({ decision: internalDecision, processor: processorDecision?.processor ?? null, context: req.body });
    }

    return res.json({
      decision:  processorDecision ?? { routeType: "processor_direct", processor: "interswitch-africa" },
      processor: processorDecision?.processor ?? null,
      strategy:  processorDecision?.strategy ?? "lowest_cost",
      context:   req.body,
    });
  } catch (err) {
    return res.status(500).json({ error: "Route selection failed" });
  }
});

export default router;
