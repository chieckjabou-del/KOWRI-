import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
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

export const insertIdempotencyKeySchema = createInsertSchema(idempotencyKeysTable).omit({ id: true, createdAt: true });
export const insertEventLogSchema = createInsertSchema(eventLogTable).omit({ id: true, createdAt: true });
export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({ id: true, timestamp: true });

export type IdempotencyKey = typeof idempotencyKeysTable.$inferSelect;
export type EventLog = typeof eventLogTable.$inferSelect;
export type AuditLog = typeof auditLogsTable.$inferSelect;
export type InsertIdempotencyKey = z.infer<typeof insertIdempotencyKeySchema>;
export type InsertEventLog = z.infer<typeof insertEventLogSchema>;
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
