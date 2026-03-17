import { pgTable, text, boolean, timestamp, numeric } from "drizzle-orm/pg-core";

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

export type KillSwitchRow = typeof killSwitchesTable.$inferSelect;
export type MetricRow     = typeof metricsTable.$inferSelect;
export type IncidentRow   = typeof incidentsTable.$inferSelect;
