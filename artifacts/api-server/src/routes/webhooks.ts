import { Router } from "express";
import { db } from "@workspace/db";
import { webhooksTable } from "@workspace/db";
import { eq, desc, count } from "drizzle-orm";
import { generateId } from "../lib/id";
import { randomBytes } from "crypto";

const router = Router();

const VALID_EVENT_TYPES = [
  "transaction.completed",
  "wallet.balance.updated",
  "loan.disbursed",
  "merchant.payment.completed",
  "fraud.alert.triggered",
  "settlement.started",
  "settlement.completed",
];

router.get("/", async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const [webhooks, [{ total }]] = await Promise.all([
      db.select({
        id: webhooksTable.id,
        url: webhooksTable.url,
        eventType: webhooksTable.eventType,
        active: webhooksTable.active,
        createdAt: webhooksTable.createdAt,
      }).from(webhooksTable).orderBy(desc(webhooksTable.createdAt)).limit(limit).offset(offset),
      db.select({ total: count() }).from(webhooksTable),
    ]);

    return res.json({ webhooks, pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) } });
  } catch (err) { return next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const { url, event_type, eventType } = req.body;
    const evType = event_type ?? eventType;

    if (!url || !evType) {
      return res.status(400).json({ error: true, message: "url and event_type are required" });
    }
    if (!VALID_EVENT_TYPES.includes(evType)) {
      return res.status(400).json({ error: true, message: `Invalid event_type. Valid: ${VALID_EVENT_TYPES.join(", ")}` });
    }

    const id = generateId();
    const secret = randomBytes(32).toString("hex");

    await db.insert(webhooksTable).values({ id, url, eventType: evType, secret, active: true });

    const [created] = await db.select().from(webhooksTable).where(eq(webhooksTable.id, id));
    return res.status(201).json({ ...created, _secret: secret, message: "Store the secret — it will not be shown again" });
  } catch (err) { return next(err); }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const { active } = req.body;
    await db.update(webhooksTable).set({ active: !!active }).where(eq(webhooksTable.id, req.params.id));
    const [updated] = await db.select().from(webhooksTable).where(eq(webhooksTable.id, req.params.id));
    if (!updated) { res.status(404).json({ error: true, message: "Webhook not found" }); return; }
    return res.json(updated);
  } catch (err) { return next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await db.delete(webhooksTable).where(eq(webhooksTable.id, req.params.id));
    return res.json({ message: "Webhook deleted" });
  } catch (err) { return next(err); }
});

router.get("/events", async (_req, res) => {
  return res.json({ supportedEvents: VALID_EVENT_TYPES });
});

export default router;
