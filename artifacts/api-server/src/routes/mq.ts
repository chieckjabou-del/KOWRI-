import { Router } from "express";
import { db } from "@workspace/db";
import { messageQueueTable } from "@workspace/db";
import { desc, sql, count } from "drizzle-orm";
import { messageQueue, MESSAGE_TOPICS, MessageProducer } from "../lib/messageQueue";

const router = Router();

router.get("/topics", (_req, res) => {
  return res.json({
    topics: messageQueue.getTopics(),
    description: {
      [MESSAGE_TOPICS.TRANSACTIONS]:   "All financial transaction events",
      [MESSAGE_TOPICS.LEDGER_EVENTS]:  "Ledger entry events and reconciliation",
      [MESSAGE_TOPICS.FRAUD_ALERTS]:   "Fraud detection alerts",
      [MESSAGE_TOPICS.WALLET_UPDATES]: "Wallet balance and status changes",
      [MESSAGE_TOPICS.SETTLEMENTS]:    "Settlement lifecycle events",
      [MESSAGE_TOPICS.NOTIFICATIONS]:  "User and system notifications",
      [MESSAGE_TOPICS.COMPLIANCE]:     "AML and compliance events",
      [MESSAGE_TOPICS.FX_RATES]:       "FX rate update events",
    },
  });
});

router.get("/stats", async (_req, res) => {
  try {
    const stats  = messageQueue.getStats();
    const depth  = await messageQueue.getQueueDepth();
    const [total] = await db.select({ cnt: count() }).from(messageQueueTable);
    const byTopic = await db.select({
      topic: messageQueueTable.topic,
      cnt:   sql<number>`count(*)`,
    }).from(messageQueueTable).groupBy(messageQueueTable.topic);

    return res.json({
      stats,
      depth,
      totalMessages: Number(total.cnt),
      byTopic:       Object.fromEntries(byTopic.map((r) => [r.topic, Number(r.cnt)])),
      brokerMode:    "in-process (Kafka/RabbitMQ compatible abstraction)",
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch MQ stats" });
  }
});

router.get("/messages", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const topic = req.query.topic as string | undefined;
    const messages = await db.select().from(messageQueueTable).orderBy(desc(messageQueueTable.createdAt)).limit(limit);
    const filtered = topic ? messages.filter((m) => m.topic === topic) : messages;
    return res.json({ messages: filtered, total: filtered.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch messages" });
  }
});

router.post("/publish", async (req, res) => {
  try {
    const { topic, payload } = req.body;
    if (!topic || !payload) return res.status(400).json({ error: "topic and payload are required" });
    if (!messageQueue.getTopics().includes(topic)) {
      return res.status(400).json({ error: "Unknown topic", validTopics: messageQueue.getTopics() });
    }
    const producer = new MessageProducer(topic);
    const id = await producer.send(payload);
    return res.status(201).json({ id, topic, status: "published" });
  } catch (err) {
    return res.status(500).json({ error: "Failed to publish message" });
  }
});

router.post("/replay", async (req, res) => {
  try {
    const { topic, fromDate, consumerGroup } = req.body;
    if (!topic) return res.status(400).json({ error: "topic is required" });
    const from    = fromDate ? new Date(fromDate) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const replayed = await messageQueue.replay(topic, from, consumerGroup);
    return res.json({ topic, replayed, fromDate: from });
  } catch (err) {
    return res.status(500).json({ error: "Replay failed" });
  }
});

export default router;
