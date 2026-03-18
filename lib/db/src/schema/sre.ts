import { pgTable, text, boolean, timestamp, numeric, integer, jsonb } from "drizzle-orm/pg-core";

// ── Kill Switches ─────────────────────────────────────────────────────────────
// Persistent source of truth for all operational kill switches.
// enabled=true → ENABLED; enabled=false → TRIGGERED or FORCED_OFF (resolved in-memory).
// On restart, enabled=false is conservatively loaded as FORCED_OFF.
export const killSwitchesTable = pgTable("kill_switches", {
  name:      text("name").primaryKey(),
  enabled:   boolean("enabled").notNull().default(true),
  reason:    text("reason").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Metrics Snapshots ─────────────────────────────────────────────────────────
// Lightweight time-series for key system metrics.
// key: dotted path e.g. "outbox.pending", "db.latencyMs"
// value: stored as numeric so aggregations work without casting
export const metricsTable = pgTable("metrics", {
  id:        text("id").primaryKey(),
  key:       text("key").notNull(),
  value:     numeric("value", { precision: 20, scale: 4 }).notNull(),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
});

// ── Incident Memory ───────────────────────────────────────────────────────────
// Append-only log of auto-heal loop decisions.
// type:   what was detected   e.g. "latency_spike"
// action: what was taken      e.g. "fire:outbound_transfers"
// result: outcome             e.g. "recovered" | "escalated" | "noop"
export const incidentsTable = pgTable("incidents", {
  id:        text("id").primaryKey(),
  type:      text("type").notNull(),
  action:    text("action").notNull(),
  result:    text("result").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── Ledger Balance Summary ────────────────────────────────────────────────────
// Singleton row (id = 1) maintained by a PostgreSQL trigger on ledger_entries.
// Replaces the O(N) SUM(credit_amount)/SUM(debit_amount) scan in metricsCollector
// with an O(1) single-row read every autopilot cycle.
//
// Seeded on API server startup via lib/ledgerBalanceSeeder.ts.
// Trigger: maintain_ledger_balance_summary() on INSERT/UPDATE/DELETE of ledger_entries.
export const ledgerBalanceSummaryTable = pgTable("ledger_balance_summary", {
  id:          integer("id").primaryKey(),
  totalCredit: numeric("total_credit", { precision: 20, scale: 4 }).notNull().default("0"),
  totalDebit:  numeric("total_debit",  { precision: 20, scale: 4 }).notNull().default("0"),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
});

// ── System State ──────────────────────────────────────────────────────────────
// Single-row key-value store for persisting autopilot in-memory state across
// restarts. One row per named component (key = 'autopilot').
export const systemStateTable = pgTable("system_state", {
  key:       text("key").primaryKey(),
  value:     jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type KillSwitchRow           = typeof killSwitchesTable.$inferSelect;
export type MetricRow               = typeof metricsTable.$inferSelect;
export type IncidentRow             = typeof incidentsTable.$inferSelect;
export type LedgerBalanceSummaryRow = typeof ledgerBalanceSummaryTable.$inferSelect;
export type SystemStateRow          = typeof systemStateTable.$inferSelect;
