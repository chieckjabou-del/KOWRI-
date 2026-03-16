import { db } from "@workspace/db";
import {
  messageQueueTable,
  eventLogTable,
} from "@workspace/db";
import { generateId } from "./id";
import { eq, and, lt, asc } from "drizzle-orm";
import { EventEmitter } from "events";

export const MESSAGE_TOPICS = {
  TRANSACTIONS:    "transactions",
  LEDGER_EVENTS:   "ledger_events",
  FRAUD_ALERTS:    "fraud_alerts",
  WALLET_UPDATES:  "wallet_updates",
  SETTLEMENTS:     "settlements",
  NOTIFICATIONS:   "notifications",
  COMPLIANCE:      "compliance",
  FX_RATES:        "fx_rates",
} as const;

export type MessageTopic = typeof MESSAGE_TOPICS[keyof typeof MESSAGE_TOPICS];

export interface QueueMessage {
  id:      string;
  topic:   MessageTopic | string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

interface ConsumerHandler {
  topic: string;
  group: string;
  handler: (msg: QueueMessage) => Promise<void>;
}

class KowriMessageQueue extends EventEmitter {
  private handlers: ConsumerHandler[] = [];
  private stats = { produced: 0, consumed: 0, failed: 0, replayable: 0 };

  async produce(topic: MessageTopic | string, payload: Record<string, unknown>): Promise<string> {
    const id = generateId();
    await db.insert(messageQueueTable).values({
      id,
      topic,
      payload: payload as any,
      status: "pending",
    });
    this.stats.produced++;
    this.stats.replayable++;
    this.emit(`topic:${topic}`, { id, topic, payload, createdAt: new Date() });
    setImmediate(() => this.dispatch(topic, { id, topic, payload, createdAt: new Date() }));
    return id;
  }

  subscribe(topic: string, group: string, handler: (msg: QueueMessage) => Promise<void>): void {
    this.handlers.push({ topic, group, handler });
    this.on(`topic:${topic}`, (msg: QueueMessage) => {
      handler(msg).catch((err) => {
        console.error(`[MessageQueue] Consumer error topic=${topic} group=${group}:`, err);
        this.stats.failed++;
      });
    });
  }

  private async dispatch(topic: string, msg: QueueMessage): Promise<void> {
    const relevant = this.handlers.filter((h) => h.topic === topic);
    for (const h of relevant) {
      try {
        await h.handler(msg);
        await db.update(messageQueueTable)
          .set({ status: "processed", processedAt: new Date(), attempts: 1 })
          .where(eq(messageQueueTable.id, msg.id));
        this.stats.consumed++;
      } catch (err) {
        await db.update(messageQueueTable)
          .set({ status: "failed", attempts: 1 })
          .where(eq(messageQueueTable.id, msg.id));
        this.stats.failed++;
      }
    }
  }

  async replay(topic: string, fromDate: Date, consumerGroup?: string): Promise<number> {
    const messages = await db.select()
      .from(messageQueueTable)
      .where(
        and(
          eq(messageQueueTable.topic, topic),
          lt(messageQueueTable.createdAt, new Date())
        )
      )
      .orderBy(asc(messageQueueTable.createdAt))
      .limit(1000);

    let replayed = 0;
    for (const row of messages) {
      const msg: QueueMessage = {
        id: row.id,
        topic: row.topic as MessageTopic,
        payload: row.payload as Record<string, unknown>,
        createdAt: row.createdAt,
      };
      await this.dispatch(topic, msg);
      replayed++;
    }
    return replayed;
  }

  getStats() {
    return { ...this.stats };
  }

  getTopics(): string[] {
    return Object.values(MESSAGE_TOPICS);
  }

  async getQueueDepth(topic?: string): Promise<Record<string, number>> {
    const rows = await db.select().from(messageQueueTable).limit(5000);
    const depth: Record<string, number> = {};
    for (const row of rows) {
      if (row.status === "pending") {
        depth[row.topic] = (depth[row.topic] ?? 0) + 1;
      }
    }
    return topic ? { [topic]: depth[topic] ?? 0 } : depth;
  }
}

export const messageQueue = new KowriMessageQueue();
messageQueue.setMaxListeners(200);

export class MessageProducer {
  constructor(private defaultTopic?: MessageTopic | string) {}

  async send(payload: Record<string, unknown>, topic?: MessageTopic | string): Promise<string> {
    const t = topic ?? this.defaultTopic;
    if (!t) throw new Error("No topic specified");
    return messageQueue.produce(t as MessageTopic, payload);
  }
}

export class MessageConsumer {
  constructor(private group: string) {}

  on(topic: MessageTopic | string, handler: (msg: QueueMessage) => Promise<void>): this {
    messageQueue.subscribe(topic, this.group, handler);
    return this;
  }
}
