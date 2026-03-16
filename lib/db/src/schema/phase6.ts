import { pgTable, text, boolean, integer, numeric, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const productSessionsTable = pgTable("product_sessions", {
  id:        text("id").primaryKey(),
  userId:    text("user_id").notNull(),
  token:     text("token").notNull().unique(),
  type:      text("type").notNull().default("wallet"),
  deviceId:  text("device_id"),
  ipAddress: text("ip_address"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at").notNull().defaultNow(),
}, (t) => [
  index("sessions_token_idx").on(t.token),
  index("sessions_user_idx").on(t.userId),
]);

export const productQrCodesTable = pgTable("product_qr_codes", {
  id:         text("id").primaryKey(),
  entityId:   text("entity_id").notNull(),
  entityType: text("entity_type").notNull().default("wallet"),
  amount:     numeric("amount", { precision: 20, scale: 4 }),
  currency:   text("currency").notNull().default("XOF"),
  label:      text("label"),
  qrData:     text("qr_data").notNull(),
  status:     text("status").notNull().default("active"),
  useCount:   integer("use_count").notNull().default(0),
  maxUses:    integer("max_uses"),
  expiresAt:  timestamp("expires_at"),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("qr_entity_idx").on(t.entityId),
  index("qr_status_idx").on(t.status),
]);

export const productPaymentLinksTable = pgTable("product_payment_links", {
  id:          text("id").primaryKey(),
  merchantId:  text("merchant_id").notNull(),
  slug:        text("slug").notNull().unique(),
  title:       text("title").notNull(),
  description: text("description"),
  amount:      numeric("amount", { precision: 20, scale: 4 }),
  currency:    text("currency").notNull().default("XOF"),
  status:      text("status").notNull().default("active"),
  clickCount:  integer("click_count").notNull().default(0),
  paidCount:   integer("paid_count").notNull().default(0),
  metadata:    jsonb("metadata"),
  expiresAt:   timestamp("expires_at"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("paylinks_merchant_idx").on(t.merchantId),
  index("paylinks_slug_idx").on(t.slug),
]);

export const productInvoicesTable = pgTable("product_invoices", {
  id:             text("id").primaryKey(),
  merchantId:     text("merchant_id").notNull(),
  invoiceNumber:  text("invoice_number").notNull().unique(),
  customerName:   text("customer_name").notNull(),
  customerEmail:  text("customer_email"),
  customerPhone:  text("customer_phone"),
  items:          jsonb("items").notNull().default([]),
  subtotal:       numeric("subtotal", { precision: 20, scale: 4 }).notNull().default("0"),
  tax:            numeric("tax", { precision: 20, scale: 4 }).notNull().default("0"),
  total:          numeric("total", { precision: 20, scale: 4 }).notNull().default("0"),
  currency:       text("currency").notNull().default("XOF"),
  status:         text("status").notNull().default("draft"),
  notes:          text("notes"),
  dueAt:          timestamp("due_at"),
  paidAt:         timestamp("paid_at"),
  transactionId:  text("transaction_id"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("invoices_merchant_idx").on(t.merchantId),
  index("invoices_status_idx").on(t.status),
]);

export const developerApiKeysTable = pgTable("developer_api_keys", {
  id:           text("id").primaryKey(),
  developerId:  text("developer_id").notNull(),
  name:         text("name").notNull(),
  keyPrefix:    text("key_prefix").notNull(),
  keyHash:      text("key_hash").notNull(),
  scopes:       jsonb("scopes").notNull().default([]),
  planTier:     text("plan_tier").notNull().default("free"),
  active:       boolean("active").notNull().default(true),
  dailyLimit:   integer("daily_limit").notNull().default(1000),
  monthlyLimit: integer("monthly_limit").notNull().default(10000),
  requestCount: integer("request_count").notNull().default(0),
  lastUsedAt:   timestamp("last_used_at"),
  environment:  text("environment").notNull().default("sandbox"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("devkeys_developer_idx").on(t.developerId),
  index("devkeys_prefix_idx").on(t.keyPrefix),
]);

export const developerUsageLogsTable = pgTable("developer_usage_logs", {
  id:         text("id").primaryKey(),
  apiKeyId:   text("api_key_id").notNull(),
  endpoint:   text("endpoint").notNull(),
  method:     text("method").notNull().default("GET"),
  statusCode: integer("status_code").notNull().default(200),
  responseMs: integer("response_ms").notNull().default(0),
  ipAddress:  text("ip_address"),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("usage_key_idx").on(t.apiKeyId),
  index("usage_created_idx").on(t.createdAt),
]);

export const productNotificationsTable = pgTable("product_notifications", {
  id:        text("id").primaryKey(),
  userId:    text("user_id").notNull(),
  type:      text("type").notNull(),
  title:     text("title").notNull(),
  message:   text("message").notNull(),
  channel:   text("channel").notNull().default("in_app"),
  read:      boolean("read").notNull().default(false),
  metadata:  jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("notifs_user_idx").on(t.userId),
  index("notifs_read_idx").on(t.read),
]);
