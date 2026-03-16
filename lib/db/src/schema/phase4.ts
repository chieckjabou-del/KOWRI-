import { pgTable, text, boolean, integer, numeric, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const ledgerShardsTable = pgTable("ledger_shards", {
  id:               text("id").primaryKey(),
  shardKey:         text("shard_key").notNull().unique(),
  shardIndex:       integer("shard_index").notNull(),
  walletIdRangeStart: text("wallet_id_range_start"),
  walletIdRangeEnd:   text("wallet_id_range_end"),
  entryCount:       integer("entry_count").notNull().default(0),
  active:           boolean("active").notNull().default(true),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
});

export const paymentRoutesTable = pgTable("payment_routes", {
  id:         text("id").primaryKey(),
  routeType:  text("route_type").notNull(),
  processor:  text("processor").notNull(),
  priority:   integer("priority").notNull().default(100),
  active:     boolean("active").notNull().default(true),
  config:     jsonb("config").notNull().default({}),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
  updatedAt:  timestamp("updated_at").notNull().defaultNow(),
});

export const amlFlagsTable = pgTable("aml_flags", {
  id:            text("id").primaryKey(),
  walletId:      text("wallet_id").notNull(),
  transactionId: text("transaction_id"),
  reason:        text("reason").notNull(),
  severity:      text("severity").notNull().default("medium"),
  metadata:      jsonb("metadata"),
  reviewed:      boolean("reviewed").notNull().default(false),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("aml_flags_wallet_idx").on(t.walletId)]);

export const complianceCasesTable = pgTable("compliance_cases", {
  id:         text("id").primaryKey(),
  walletId:   text("wallet_id").notNull(),
  caseType:   text("case_type").notNull(),
  status:     text("status").notNull().default("open"),
  severity:   text("severity").notNull().default("medium"),
  details:    jsonb("details"),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
}, (t) => [index("compliance_cases_wallet_idx").on(t.walletId)]);

export const fxRateHistoryTable = pgTable("fx_rate_history", {
  id:             text("id").primaryKey(),
  baseCurrency:   text("base_currency").notNull(),
  targetCurrency: text("target_currency").notNull(),
  rate:           numeric("rate", { precision: 20, scale: 8 }).notNull(),
  source:         text("source").notNull().default("internal"),
  recordedAt:     timestamp("recorded_at").notNull().defaultNow(),
}, (t) => [index("fx_history_pair_idx").on(t.baseCurrency, t.targetCurrency, t.recordedAt)]);

export const messageQueueTable = pgTable("message_queue", {
  id:            text("id").primaryKey(),
  topic:         text("topic").notNull(),
  payload:       jsonb("payload").notNull(),
  status:        text("status").notNull().default("pending"),
  consumerGroup: text("consumer_group"),
  attempts:      integer("attempts").notNull().default(0),
  processedAt:   timestamp("processed_at"),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("mq_topic_status_idx").on(t.topic, t.status),
  index("mq_created_idx").on(t.createdAt),
]);

export const ledgerArchiveTable = pgTable("ledger_archive", {
  id:           text("id").primaryKey(),
  originalTxId: text("original_tx_id").notNull(),
  walletId:     text("wallet_id").notNull(),
  type:         text("type").notNull(),
  amount:       numeric("amount", { precision: 20, scale: 4 }).notNull(),
  currency:     text("currency").notNull(),
  balanceAfter: numeric("balance_after", { precision: 20, scale: 4 }),
  archiveYear:  integer("archive_year").notNull(),
  archivedAt:   timestamp("archived_at").notNull().defaultNow(),
  originalCreatedAt: timestamp("original_created_at"),
}, (t) => [
  index("archive_wallet_year_idx").on(t.walletId, t.archiveYear),
  index("archive_year_idx").on(t.archiveYear),
]);

export const serviceTracesTable = pgTable("service_traces", {
  id:          text("id").primaryKey(),
  traceId:     text("trace_id").notNull(),
  spanId:      text("span_id").notNull(),
  parentSpanId: text("parent_span_id"),
  service:     text("service").notNull(),
  operation:   text("operation").notNull(),
  durationMs:  integer("duration_ms"),
  status:      text("status").notNull().default("ok"),
  metadata:    jsonb("metadata"),
  startedAt:   timestamp("started_at").notNull().defaultNow(),
}, (t) => [
  index("traces_trace_id_idx").on(t.traceId),
  index("traces_service_idx").on(t.service),
]);

export const connectorsTable = pgTable("connectors", {
  id:           text("id").primaryKey(),
  name:         text("name").notNull(),
  connectorType: text("connector_type").notNull(),
  active:       boolean("active").notNull().default(true),
  config:       jsonb("config").notNull().default({}),
  lastPingMs:   integer("last_ping_ms"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
  updatedAt:    timestamp("updated_at").notNull().defaultNow(),
});
