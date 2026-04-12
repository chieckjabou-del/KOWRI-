import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const floatOperationStatusEnum = pgEnum("float_operation_status", [
  "held",
  "released",
  "cancelled",
]);

export const floatOperationSourceEnum = pgEnum("float_operation_source", [
  "tontine",
  "wallet",
  "deposit",
  "bid",
  "penalty",
  "fx",
]);

export const floatOperationsTable = pgTable("float_operations", {
  id: text("id").primaryKey(),
  amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
  currency: text("currency").notNull().default("XOF"),
  source: floatOperationSourceEnum("source").notNull(),
  sourceRef: text("source_ref").notNull(),
  userId: text("user_id").references(() => usersTable.id),
  heldAt: timestamp("held_at").notNull().defaultNow(),
  releaseAt: timestamp("release_at").notNull(),
  releasedAt: timestamp("released_at"),
  status: floatOperationStatusEnum("status").notNull().default("held"),
  metadata: jsonb("metadata"),
}, (t) => [
  index("floatops_source_idx").on(t.source),
  index("floatops_source_ref_idx").on(t.sourceRef),
  index("floatops_status_idx").on(t.status),
  index("floatops_release_at_idx").on(t.releaseAt),
]);

export const floatAccountsTable = pgTable("float_accounts", {
  id: text("id").primaryKey(),
  currency: text("currency").notNull(),
  totalHeld: numeric("total_held", { precision: 20, scale: 4 }).notNull().default("0"),
  totalReleased: numeric("total_released", { precision: 20, scale: 4 }).notNull().default("0"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("float_accounts_currency_uniq").on(t.currency),
  index("float_accounts_currency_idx").on(t.currency),
]);

export const floatPoliciesTable = pgTable("float_policies", {
  source: floatOperationSourceEnum("source").primaryKey(),
  holdingPeriodMinutes: integer("holding_period_minutes").notNull().default(60),
  active: boolean("active").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const monetizationFeeTypeEnum = pgEnum("monetization_fee_type", [
  "withdrawal_fee",
  "express_payout_fee",
  "transfer_fee",
  "bid_fee",
  "fx_margin_fee",
  "penalty_fee",
]);

export const monetizationFeeValueTypeEnum = pgEnum("monetization_fee_value_type", [
  "percent",
  "fixed",
]);

export const monetizationFeesConfigTable = pgTable("monetization_fees_config", {
  id: text("id").primaryKey(),
  type: monetizationFeeTypeEnum("type").notNull(),
  valueType: monetizationFeeValueTypeEnum("value_type").notNull().default("percent"),
  value: numeric("value", { precision: 20, scale: 6 }).notNull(),
  currency: text("currency").notNull().default("XOF"),
  condition: jsonb("condition"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("mfee_type_idx").on(t.type),
  index("mfee_active_idx").on(t.active),
]);

export const premiumPlanEnum = pgEnum("premium_plan", [
  "starter",
  "pro",
  "elite",
]);

export const premiumSubscriptionStatusEnum = pgEnum("premium_subscription_status", [
  "active",
  "expired",
  "cancelled",
]);

export const premiumSubscriptionsTable = pgTable("premium_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  plan: premiumPlanEnum("plan").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  status: premiumSubscriptionStatusEnum("status").notNull().default("active"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("premium_user_idx").on(t.userId),
  index("premium_status_idx").on(t.status),
  index("premium_expires_idx").on(t.expiresAt),
]);

export const fxTransactionsTable = pgTable("fx_transactions", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => usersTable.id),
  fromCurrency: text("from_currency").notNull(),
  toCurrency: text("to_currency").notNull(),
  amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
  convertedAmount: numeric("converted_amount", { precision: 20, scale: 4 }).notNull(),
  rate: numeric("rate", { precision: 20, scale: 8 }).notNull(),
  fee: numeric("fee", { precision: 20, scale: 4 }).notNull().default("0"),
  reference: text("reference"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("fx_tx_user_idx").on(t.userId),
  index("fx_tx_pair_idx").on(t.fromCurrency, t.toCurrency),
  index("fx_tx_created_idx").on(t.createdAt),
]);

export const revenueSourceEnum = pgEnum("revenue_source", [
  "fees",
  "bids",
  "penalties",
  "fx",
  "loan_interest",
  "subscription",
]);

export const revenueLogsTable = pgTable("revenue_logs", {
  id: text("id").primaryKey(),
  source: revenueSourceEnum("source").notNull(),
  feature: text("feature").notNull(),
  userId: text("user_id").references(() => usersTable.id),
  amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
  currency: text("currency").notNull().default("XOF"),
  reference: text("reference"),
  metadata: jsonb("metadata"),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
}, (t) => [
  index("revenue_source_idx").on(t.source),
  index("revenue_feature_idx").on(t.feature),
  index("revenue_timestamp_idx").on(t.timestamp),
  index("revenue_user_idx").on(t.userId),
]);
