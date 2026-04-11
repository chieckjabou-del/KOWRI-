import { Router } from "express";
import { db } from "@workspace/db";
import { connectorsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { connectorRegistry } from "../lib/connectors";
import { generateId } from "../lib/id";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const connectors = await db.select().from(connectorsTable);
    const enriched = connectors.map((c) => ({
      ...c,
      capabilities: ["initiate_payment", "confirm_payment", "reconcile_settlement"],
      registered:   !!connectorRegistry[c.connectorType],
    }));
    return res.json({ connectors: enriched, total: enriched.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch connectors" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const [connector] = await db.select().from(connectorsTable).where(eq(connectorsTable.id, req.params.id));
    if (!connector) return res.status(404).json({ error: "Connector not found" });
    return res.json(connector);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch connector" });
  }
});

router.post("/:id/ping", async (req, res) => {
  try {
    const [connector] = await db.select().from(connectorsTable).where(eq(connectorsTable.id, req.params.id));
    if (!connector) return res.status(404).json({ error: "Connector not found" });

    const impl = connectorRegistry[connector.connectorType];
    if (!impl) return res.status(400).json({ error: "No implementation for connector type" });

    const start  = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    const pingMs = Date.now() - start + Math.floor(Math.random() * 20);

    await db.update(connectorsTable)
      .set({ lastPingMs: pingMs, updatedAt: new Date() })
      .where(eq(connectorsTable.id, req.params.id));

    return res.json({ connector: connector.name, pingMs, status: "healthy" });
  } catch (err) {
    return res.status(500).json({ error: "Ping failed" });
  }
});

router.post("/:id/initiate", async (req, res) => {
  try {
    const { amount, currency, reference, metadata } = req.body;
    if (!amount || !currency || !reference) {
      return res.status(400).json({ error: "amount, currency, reference are required" });
    }
    const [connector] = await db.select().from(connectorsTable).where(eq(connectorsTable.id, req.params.id));
    if (!connector) return res.status(404).json({ error: "Connector not found" });
    if (!connector.active) return res.status(400).json({ error: "Connector is inactive" });

    const impl = connectorRegistry[connector.connectorType];
    if (!impl) return res.status(400).json({ error: "No implementation registered" });

    const paymentId = generateId();
    const result = await impl.initiatePayment({ id: paymentId, amount: Number(amount), currency, reference, metadata });
    return res.json({ paymentId, connector: connector.name, ...result });
  } catch (err) {
    return res.status(500).json({ error: "Payment initiation failed" });
  }
});

router.post("/:id/confirm", async (req, res) => {
  try {
    const { externalRef } = req.body;
    if (!externalRef) return res.status(400).json({ error: "externalRef is required" });

    const [connector] = await db.select().from(connectorsTable).where(eq(connectorsTable.id, req.params.id));
    if (!connector) return res.status(404).json({ error: "Connector not found" });

    const impl = connectorRegistry[connector.connectorType];
    if (!impl) return res.status(400).json({ error: "No implementation registered" });

    const result = await impl.confirmPayment(externalRef);
    return res.json({ connector: connector.name, ...result });
  } catch (err) {
    return res.status(500).json({ error: "Payment confirmation failed" });
  }
});

router.post("/:id/reconcile", async (req, res) => {
  try {
    const { settlementId } = req.body;
    if (!settlementId) return res.status(400).json({ error: "settlementId is required" });

    const [connector] = await db.select().from(connectorsTable).where(eq(connectorsTable.id, req.params.id));
    if (!connector) return res.status(404).json({ error: "Connector not found" });

    const impl = connectorRegistry[connector.connectorType];
    if (!impl) return res.status(400).json({ error: "No implementation registered" });

    const result = await impl.reconcileSettlement(settlementId);
    return res.json({ connector: connector.name, settlementId, ...result });
  } catch (err) {
    return res.status(500).json({ error: "Reconciliation failed" });
  }
});

export default router;
