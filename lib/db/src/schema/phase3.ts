import { pgTable, text, boolean, integer, numeric, timestamp, jsonb } from "drizzle-orm/pg-core";

export const sagasTable = pgTable("sagas", {
  id:          text("id").primaryKey(),
  sagaType:    text("saga_type").notNull(),
  status:      text("status").notNull().default("started"),
  steps:       jsonb("steps").notNull().default([]),
  context:     jsonb("context").notNull().default({}),
  currentStep: integer("current_step").notNull().default(0),
  error:       text("error"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
});

export const riskAlertsTable = pgTable("risk_alerts", {
  id:        text("id").primaryKey(),
  walletId:  text("wallet_id").notNull(),
  alertType: text("alert_type").notNull(),
  severity:  text("severity").notNull().default("medium"),
  metadata:  jsonb("metadata"),
  resolved:  boolean("resolved").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const webhooksTable = pgTable("webhooks", {
  id:        text("id").primaryKey(),
  url:       text("url").notNull(),
  eventType: text("event_type").notNull(),
  secret:    text("secret").notNull(),
  active:    boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const walletLimitsTable = pgTable("wallet_limits", {
  walletId:        text("wallet_id").primaryKey(),
  maxTxPerMinute:  integer("max_tx_per_minute").notNull().default(10),
  maxHourlyVolume: numeric("max_hourly_volume", { precision: 20, scale: 4 }).notNull().default("5000000"),
  maxDailyVolume:  numeric("max_daily_volume",  { precision: 20, scale: 4 }).notNull().default("20000000"),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
});

export const exchangeRatesTable = pgTable("exchange_rates", {
  id:             text("id").primaryKey(),
  baseCurrency:   text("base_currency").notNull(),
  targetCurrency: text("target_currency").notNull(),
  rate:           numeric("rate", { precision: 20, scale: 8 }).notNull(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
});

export const settlementsTable = pgTable("settlements", {
  id:        text("id").primaryKey(),
  partner:   text("partner").notNull(),
  amount:    numeric("amount", { precision: 20, scale: 4 }).notNull(),
  currency:  text("currency").notNull(),
  status:    text("status").notNull().default("pending"),
  metadata:  jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  settledAt: timestamp("settled_at"),
});
