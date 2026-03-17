import { pgTable, text, jsonb, timestamp, smallint, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const idempotencyKeysTable = pgTable("idempotency_keys", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  endpoint: text("endpoint").notNull(),
  responseBody: jsonb("response_body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const eventLogTable = pgTable("event_log", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const auditLogsTable = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  actor: text("actor").notNull().default("system"),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  metadata: jsonb("metadata"),
});

export const outboxEventsTable = pgTable("outbox_events", {
  id:        text("id").primaryKey(),
  topic:     text("topic").notNull(),
  payload:   jsonb("payload").notNull(),
  status:    text("status").notNull().default("pending"),
  attempts:  smallint("attempts").notNull().default(0),
  retries:   integer("retries").notNull().default(0),
  priority:  smallint("priority").notNull().default(5),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  processAt: timestamp("process_at").notNull().defaultNow(),
});

/**
 * Idempotency fence for outbox consumers.
 * One row per outbox_event_id — unique constraint is the guard.
 * Hard-delete rows older than 7 days via nightly job.
 */
export const processedEventsTable = pgTable("processed_events", {
  id:            text("id").primaryKey(),
  outboxEventId: text("outbox_event_id").notNull().unique(),
  topic:         text("topic").notNull(),
  processedAt:   timestamp("processed_at").notNull().defaultNow(),
});

export const insertIdempotencyKeySchema = createInsertSchema(idempotencyKeysTable).omit({ id: true, createdAt: true });
export const insertEventLogSchema = createInsertSchema(eventLogTable).omit({ id: true, createdAt: true });
export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({ id: true, timestamp: true });

export type IdempotencyKey = typeof idempotencyKeysTable.$inferSelect;
export type EventLog = typeof eventLogTable.$inferSelect;
export type AuditLog = typeof auditLogsTable.$inferSelect;
export type InsertIdempotencyKey = z.infer<typeof insertIdempotencyKeySchema>;
export type InsertEventLog = z.infer<typeof insertEventLogSchema>;
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
