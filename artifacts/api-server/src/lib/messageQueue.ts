import { db } from "@workspace/db";
import {
  messageQueueTable,
  eventLogTable,
} from "@workspace/db";
import { generateId } from "./id";
import { eq, and, lt, asc, inArray } from "drizzle-orm";
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
  topic:   string;
  group:   string;
  handler: (msg: QueueMessage) => Promise<void>;
}

const MAX_DISPATCH_ATTEMPTS = 3;
const DLQ_TOPIC_PREFIX      = "dlq:";
const REPLAY_BATCH_SIZE     = 50;
const REPLAY_CONCURRENCY    = 5;

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

class KowriMessageQueue extends EventEmitter {
  private handlers: ConsumerHandler[] = [];
  private stats = { produced: 0, consumed: 0, failed: 0, deadLettered: 0, replayable: 0 };

  async produce(topic: MessageTopic | string, payload: Record<string, unknown>): Promise<string> {
    const id = generateId();
    await db.insert(messageQueueTable).values({
      id,
      topic,
      payload: payload as any,
      status:  "pending",
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
      let lastErr: unknown;
      let success = false;

      for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
        try {
          await h.handler(msg);
          await db.update(messageQueueTable)
            .set({ status: "processed", processedAt: new Date(), attempts: attempt })
            .where(eq(messageQueueTable.id, msg.id));
          this.stats.consumed++;
          success = true;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`[MessageQueue] Attempt ${attempt}/${MAX_DISPATCH_ATTEMPTS} failed topic=${topic} id=${msg.id}:`, err);
          if (attempt < MAX_DISPATCH_ATTEMPTS) {
            await sleep(Math.pow(2, attempt) * 100 + Math.random() * 50);
          }
        }
      }

      if (!success) {
        const dlqTopic = `${DLQ_TOPIC_PREFIX}${topic}`;
        console.error(`[MessageQueue] Dead-lettering message id=${msg.id} topic=${topic} → ${dlqTopic}`, lastErr);
        await db.update(messageQueueTable)
          .set({ status: "failed", attempts: MAX_DISPATCH_ATTEMPTS })
          .where(eq(messageQueueTable.id, msg.id));
        try {
          await db.insert(messageQueueTable).values({
            id:      generateId(),
            topic:   dlqTopic,
            payload: { original: msg.payload, originalId: msg.id, originalTopic: topic, error: String(lastErr) } as any,
            status:  "pending",
          });
        } catch (_) {}
        this.stats.failed++;
        this.stats.deadLettered++;
      }
    }
  }

  async replay(topic: string, fromDate: Date, consumerGroup?: string): Promise<number> {
    const messages = await db.select()
      .from(messageQueueTable)
      .where(
        and(
          eq(messageQueueTable.topic, topic),
          lt(messageQueueTable.createdAt, new Date()),
        )
      )
      .orderBy(asc(messageQueueTable.createdAt))
      .limit(1000);

    let replayed = 0;

    for (let i = 0; i < messages.length; i += REPLAY_BATCH_SIZE) {
      const batch = messages.slice(i, i + REPLAY_BATCH_SIZE);

      const concurrentSlots: Promise<void>[] = [];
      for (let j = 0; j < batch.length; j += REPLAY_CONCURRENCY) {
        const slot = batch.slice(j, j + REPLAY_CONCURRENCY);
        concurrentSlots.push(
          Promise.all(
            slot.map(row => {
              const msg: QueueMessage = {
                id:        row.id,
                topic:     row.topic as MessageTopic,
                payload:   row.payload as Record<string, unknown>,
                createdAt: row.createdAt,
              };
              return this.dispatch(topic, msg).then(() => { replayed++; }).catch(() => {});
            })
          ).then(() => {})
        );
      }
      await Promise.all(concurrentSlots);
      await sleep(100);
    }

    return replayed;
  }

  async retryDeadLettered(originalTopic: string): Promise<number> {
    const dlqTopic = `${DLQ_TOPIC_PREFIX}${originalTopic}`;
    const dlqRows = await db.select()
      .from(messageQueueTable)
      .where(and(eq(messageQueueTable.topic, dlqTopic), eq(messageQueueTable.status, "pending")))
      .orderBy(asc(messageQueueTable.createdAt))
      .limit(200);

    let retried = 0;
    for (const row of dlqRows) {
      const payload = row.payload as Record<string, unknown>;
      const originalPayload = (payload.original ?? payload) as Record<string, unknown>;
      try {
        await this.produce(originalTopic as MessageTopic, originalPayload);
        await db.update(messageQueueTable)
          .set({ status: "processed", processedAt: new Date() })
          .where(eq(messageQueueTable.id, row.id));
        retried++;
      } catch (_) {}
    }
    return retried;
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

  async getDeadLetterDepth(): Promise<Record<string, number>> {
    const rows = await db.select().from(messageQueueTable).limit(5000);
    const depth: Record<string, number> = {};
    for (const row of rows) {
      if (row.status === "failed") {
        depth[row.topic] = (depth[row.topic] ?? 0) + 1;
      }
    }
    return depth;
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
