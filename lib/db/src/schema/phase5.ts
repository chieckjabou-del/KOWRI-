import { pgTable, text, boolean, integer, numeric, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const clearingBatchesTable = pgTable("clearing_batches", {
  id:            text("id").primaryKey(),
  batchRef:      text("batch_ref").notNull().unique(),
  institutionId: text("institution_id").notNull(),
  status:        text("status").notNull().default("pending"),
  totalAmount:   numeric("total_amount", { precision: 20, scale: 4 }).notNull().default("0"),
  currency:      text("currency").notNull().default("XOF"),
  entryCount:    integer("entry_count").notNull().default(0),
  metadata:      jsonb("metadata"),
  submittedAt:   timestamp("submitted_at"),
  settledAt:     timestamp("settled_at"),
  failedAt:      timestamp("failed_at"),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("clearing_batches_status_idx").on(t.status),
  index("clearing_batches_institution_idx").on(t.institutionId),
]);

export const clearingEntriesTable = pgTable("clearing_entries", {
  id:            text("id").primaryKey(),
  batchId:       text("batch_id").notNull().references(() => clearingBatchesTable.id),
  fromAccountId: text("from_account_id").notNull(),
  toAccountId:   text("to_account_id").notNull(),
  amount:        numeric("amount", { precision: 20, scale: 4 }).notNull(),
  currency:      text("currency").notNull().default("XOF"),
  status:        text("status").notNull().default("pending"),
  externalRef:   text("external_ref"),
  metadata:      jsonb("metadata"),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("clearing_entries_batch_idx").on(t.batchId),
  index("clearing_entries_status_idx").on(t.status),
]);

export const fraudNetworkNodesTable = pgTable("fraud_network_nodes", {
  id:               text("id").primaryKey(),
  walletId:         text("wallet_id").notNull().unique(),
  nodeType:         text("node_type").notNull().default("wallet"),
  riskScore:        numeric("risk_score", { precision: 5, scale: 2 }).notNull().default("0"),
  transactionCount: integer("transaction_count").notNull().default(0),
  flaggedCount:     integer("flagged_count").notNull().default(0),
  metadata:         jsonb("metadata"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
  updatedAt:        timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("fraud_nodes_wallet_idx").on(t.walletId),
  index("fraud_nodes_risk_idx").on(t.riskScore),
]);

export const fraudNetworkEdgesTable = pgTable("fraud_network_edges", {
  id:               text("id").primaryKey(),
  fromNodeId:       text("from_node_id").notNull(),
  toNodeId:         text("to_node_id").notNull(),
  edgeType:         text("edge_type").notNull().default("transfer"),
  weight:           numeric("weight", { precision: 10, scale: 4 }).notNull().default("1"),
  transactionCount: integer("transaction_count").notNull().default(1),
  totalAmount:      numeric("total_amount", { precision: 20, scale: 4 }).notNull().default("0"),
  currency:         text("currency").notNull().default("XOF"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
  updatedAt:        timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("fraud_edges_from_idx").on(t.fromNodeId),
  index("fraud_edges_to_idx").on(t.toNodeId),
]);

export const fraudScoresTable = pgTable("fraud_scores", {
  id:           text("id").primaryKey(),
  walletId:     text("wallet_id").notNull(),
  score:        numeric("score", { precision: 5, scale: 2 }).notNull().default("0"),
  factors:      jsonb("factors"),
  modelVersion: text("model_version").notNull().default("v1"),
  calculatedAt: timestamp("calculated_at").notNull().defaultNow(),
}, (t) => [
  index("fraud_scores_wallet_idx").on(t.walletId),
  index("fraud_scores_score_idx").on(t.score),
]);

export const regulatoryReportsTable = pgTable("regulatory_reports", {
  id:          text("id").primaryKey(),
  reportType:  text("report_type").notNull(),
  status:      text("status").notNull().default("pending"),
  format:      text("format").notNull().default("json"),
  periodStart: timestamp("period_start"),
  periodEnd:   timestamp("period_end"),
  recordCount: integer("record_count").notNull().default(0),
  metadata:    jsonb("metadata"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  generatedAt: timestamp("generated_at"),
}, (t) => [
  index("reg_reports_type_idx").on(t.reportType),
  index("reg_reports_status_idx").on(t.status),
]);

export const reportEntriesTable = pgTable("report_entries", {
  id:        text("id").primaryKey(),
  reportId:  text("report_id").notNull().references(() => regulatoryReportsTable.id),
  entryType: text("entry_type").notNull(),
  data:      jsonb("data").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("report_entries_report_idx").on(t.reportId)]);

export const fxLiquidityPoolsTable = pgTable("fx_liquidity_pools", {
  id:             text("id").primaryKey(),
  currency:       text("currency").notNull().unique(),
  poolSize:       numeric("pool_size", { precision: 20, scale: 4 }).notNull().default("0"),
  available:      numeric("available", { precision: 20, scale: 4 }).notNull().default("0"),
  reserved:       numeric("reserved", { precision: 20, scale: 4 }).notNull().default("0"),
  utilizationPct: numeric("utilization_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  minThreshold:   numeric("min_threshold", { precision: 20, scale: 4 }).notNull().default("0"),
  metadata:       jsonb("metadata"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
});

export const fxLiquidityPositionsTable = pgTable("fx_liquidity_positions", {
  id:             text("id").primaryKey(),
  poolId:         text("pool_id").notNull().references(() => fxLiquidityPoolsTable.id),
  baseCurrency:   text("base_currency").notNull(),
  targetCurrency: text("target_currency").notNull(),
  amount:         numeric("amount", { precision: 20, scale: 4 }).notNull(),
  slippageBps:    numeric("slippage_bps", { precision: 8, scale: 2 }).notNull().default("0"),
  exposure:       numeric("exposure", { precision: 20, scale: 4 }).notNull().default("0"),
  status:         text("status").notNull().default("open"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("fx_positions_pool_idx").on(t.poolId),
  index("fx_positions_pair_idx").on(t.baseCurrency, t.targetCurrency),
]);
