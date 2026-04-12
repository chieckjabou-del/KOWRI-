import { pgTable, text, numeric, timestamp, integer, pgEnum, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { walletsTable } from "./wallets";

export const tontineStatusEnum    = pgEnum("tontine_status",    ["active", "completed", "pending", "cancelled"]);
export const tontineFrequencyEnum = pgEnum("tontine_frequency", ["weekly", "biweekly", "monthly"]);
export const tontineTypeEnum      = pgEnum("tontine_type",      [
  "classic", "investment", "project", "solidarity",
  "business", "diaspora", "yield", "growth", "hybrid",
]);
export const currencyModeEnum     = pgEnum("currency_mode",     ["single", "multi"]);

export const tontinesTable = pgTable("tontines", {
  id:                   text("id").primaryKey(),
  name:                 text("name").notNull(),
  description:          text("description"),
  contributionAmount:   numeric("contribution_amount",   { precision: 20, scale: 4 }).notNull(),
  currency:             text("currency").notNull().default("XOF"),
  frequency:            tontineFrequencyEnum("frequency").notNull(),
  maxMembers:           integer("max_members").notNull(),
  memberCount:          integer("member_count").notNull().default(0),
  currentRound:         integer("current_round").notNull().default(0),
  totalRounds:          integer("total_rounds").notNull(),
  status:               tontineStatusEnum("status").notNull().default("pending"),
  tontineType:          tontineTypeEnum("tontine_type").notNull().default("classic"),
  isPublic:             boolean("is_public").notNull().default(true),
  isMultiAmount:        boolean("is_multi_amount").notNull().default(false),
  goalDescription:      text("goal_description"),
  goalAmount:           numeric("goal_amount",            { precision: 20, scale: 4 }),
  merchantId:           text("merchant_id"),
  investmentPoolId:     text("investment_pool_id"),
  currencyMode:         currencyModeEnum("currency_mode").notNull().default("single"),
  // ── Yield mechanics ──────────────────────────────────────────────────────────
  yieldRate:            numeric("yield_rate",             { precision: 5,  scale: 2 }),
  yieldPoolBalance:     numeric("yield_pool_balance",     { precision: 20, scale: 4 }).notNull().default("0"),
  // ── Growth mechanics ─────────────────────────────────────────────────────────
  growthRate:           numeric("growth_rate",            { precision: 5,  scale: 2 }),
  // ── Hybrid config ────────────────────────────────────────────────────────────
  hybridConfig:         jsonb("hybrid_config"),
  solidarityReserve:    numeric("solidarity_reserve", { precision: 20, scale: 4 }).notNull().default("0"),
  // ── Strategy mode ────────────────────────────────────────────────────────────
  strategyMode:       boolean("strategy_mode").notNull().default(false),
  strategyZone:       text("strategy_zone"),
  strategyObjective:  text("strategy_objective"),
  networkWallets:     jsonb("network_wallets"),
  // ── Meta ─────────────────────────────────────────────────────────────────────
  adminUserId:          text("admin_user_id").notNull().references(() => usersTable.id),
  walletId:             text("wallet_id").references(() => walletsTable.id),
  nextPayoutDate:       timestamp("next_payout_date"),
  createdAt:            timestamp("created_at").notNull().defaultNow(),
  updatedAt:            timestamp("updated_at").notNull().defaultNow(),
});

export const tontineMembersTable = pgTable("tontine_members", {
  id:                   text("id").primaryKey(),
  tontineId:            text("tontine_id").notNull().references(() => tontinesTable.id),
  userId:               text("user_id").notNull().references(() => usersTable.id),
  payoutOrder:          integer("payout_order").notNull(),
  hasReceivedPayout:    integer("has_received_payout").notNull().default(0),
  contributionsCount:   integer("contributions_count").notNull().default(0),
  personalContribution: numeric("personal_contribution", { precision: 20, scale: 4 }),
  // ── Yield tracking ───────────────────────────────────────────────────────────
  yieldOwed:            numeric("yield_owed",            { precision: 20, scale: 4 }).notNull().default("0"),
  yieldPaid:            numeric("yield_paid",            { precision: 20, scale: 4 }).notNull().default("0"),
  receivedPayoutAt:     timestamp("received_payout_at"),
  joinedAt:             timestamp("joined_at").notNull().defaultNow(),
  // ── Missed contribution tracking ─────────────────────────────────────────────
  missedContributions:  integer("missed_contributions").notNull().default(0),
  memberStatus:         text("member_status").notNull().default("active"), // 'active' | 'suspended'
}, (t) => [
  index("tontine_members_tontine_idx").on(t.tontineId),
  index("tontine_members_user_idx").on(t.userId),
  index("tontine_members_payout_idx").on(t.payoutOrder),
  uniqueIndex("tontine_members_tontine_user_uniq").on(t.tontineId, t.userId),
]);

export const tontineCycleStatusEnum = pgEnum("tontine_cycle_status", [
  "open",
  "collecting",
  "ready_for_payout",
  "payout_completed",
  "closed",
]);

export const tontinePaymentStatusEnum = pgEnum("tontine_payment_status", [
  "pending",
  "completed",
  "late",
  "defaulted",
]);

export const tontinePayoutStatusEnum = pgEnum("tontine_payout_status", [
  "pending",
  "completed",
  "failed",
]);

export const tontinePenaltyStatusEnum = pgEnum("tontine_penalty_status", [
  "pending",
  "settled",
  "waived",
]);

export const tontineCyclesTable = pgTable("tontine_cycles", {
  id:            text("id").primaryKey(),
  tontineId:     text("tontine_id").notNull().references(() => tontinesTable.id),
  roundNumber:   integer("round_number").notNull(),
  dueAt:         timestamp("due_at").notNull(),
  status:        tontineCycleStatusEnum("status").notNull().default("open"),
  expectedPool:  numeric("expected_pool", { precision: 20, scale: 4 }).notNull().default("0"),
  collectedPool: numeric("collected_pool", { precision: 20, scale: 4 }).notNull().default("0"),
  payoutUserId:  text("payout_user_id").references(() => usersTable.id),
  payoutAt:      timestamp("payout_at"),
  closedAt:      timestamp("closed_at"),
  metadata:      jsonb("metadata"),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("toncycle_tontine_idx").on(t.tontineId),
  index("toncycle_round_idx").on(t.roundNumber),
  index("toncycle_status_idx").on(t.status),
  uniqueIndex("toncycle_tontine_round_uniq").on(t.tontineId, t.roundNumber),
]);

export const tontinePaymentsTable = pgTable("tontine_payments", {
  id:             text("id").primaryKey(),
  tontineId:      text("tontine_id").notNull().references(() => tontinesTable.id),
  cycleId:        text("cycle_id").notNull().references(() => tontineCyclesTable.id),
  roundNumber:    integer("round_number").notNull(),
  memberId:       text("member_id").notNull().references(() => tontineMembersTable.id),
  userId:         text("user_id").notNull().references(() => usersTable.id),
  amountDue:      numeric("amount_due", { precision: 20, scale: 4 }).notNull(),
  penaltyAmount:  numeric("penalty_amount", { precision: 20, scale: 4 }).notNull().default("0"),
  amountPaid:     numeric("amount_paid", { precision: 20, scale: 4 }).notNull().default("0"),
  currency:       text("currency").notNull().default("XOF"),
  status:         tontinePaymentStatusEnum("status").notNull().default("pending"),
  paidAt:         timestamp("paid_at"),
  dueAt:          timestamp("due_at").notNull(),
  idempotencyKey: text("idempotency_key"),
  txId:           text("tx_id"),
  metadata:       jsonb("metadata"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("tonpay_tontine_idx").on(t.tontineId),
  index("tonpay_cycle_idx").on(t.cycleId),
  index("tonpay_member_idx").on(t.memberId),
  index("tonpay_status_idx").on(t.status),
  index("tonpay_idempotency_idx").on(t.idempotencyKey),
  index("tonpay_tontine_round_member_idx").on(t.tontineId, t.roundNumber, t.memberId),
  uniqueIndex("tonpay_cycle_member_uniq").on(t.cycleId, t.memberId),
]);

export const tontinePayoutsTable = pgTable("tontine_payouts", {
  id:           text("id").primaryKey(),
  tontineId:    text("tontine_id").notNull().references(() => tontinesTable.id),
  cycleId:      text("cycle_id").notNull().references(() => tontineCyclesTable.id),
  roundNumber:  integer("round_number").notNull(),
  memberId:     text("member_id").notNull().references(() => tontineMembersTable.id),
  userId:       text("user_id").notNull().references(() => usersTable.id),
  amount:       numeric("amount", { precision: 20, scale: 4 }).notNull(),
  currency:     text("currency").notNull().default("XOF"),
  status:       tontinePayoutStatusEnum("status").notNull().default("pending"),
  paidAt:       timestamp("paid_at"),
  txId:         text("tx_id"),
  metadata:     jsonb("metadata"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("tonpayout_tontine_idx").on(t.tontineId),
  index("tonpayout_cycle_idx").on(t.cycleId),
  index("tonpayout_user_idx").on(t.userId),
  index("tonpayout_status_idx").on(t.status),
  index("tonpayout_cycle_member_idx").on(t.cycleId, t.memberId),
  uniqueIndex("tonpayout_cycle_unique").on(t.cycleId),
]);

export const tontinePenaltiesTable = pgTable("tontine_penalties", {
  id:            text("id").primaryKey(),
  tontineId:     text("tontine_id").notNull().references(() => tontinesTable.id),
  cycleId:       text("cycle_id").notNull().references(() => tontineCyclesTable.id),
  roundNumber:   integer("round_number").notNull(),
  memberId:      text("member_id").notNull().references(() => tontineMembersTable.id),
  userId:        text("user_id").notNull().references(() => usersTable.id),
  paymentId:     text("payment_id").references(() => tontinePaymentsTable.id),
  amount:        numeric("amount", { precision: 20, scale: 4 }).notNull(),
  currency:      text("currency").notNull().default("XOF"),
  reason:        text("reason").notNull(),
  status:        tontinePenaltyStatusEnum("status").notNull().default("pending"),
  assessedAt:    timestamp("assessed_at").notNull().defaultNow(),
  settledAt:     timestamp("settled_at"),
  waivedAt:      timestamp("waived_at"),
  metadata:      jsonb("metadata"),
}, (t) => [
  index("tonpen_tontine_idx").on(t.tontineId),
  index("tonpen_cycle_idx").on(t.cycleId),
  index("tonpen_member_idx").on(t.memberId),
  index("tonpen_status_idx").on(t.status),
  index("tonpen_cycle_member_idx").on(t.cycleId, t.memberId),
]);

export const insertTontineSchema       = createInsertSchema(tontinesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTontineMemberSchema = createInsertSchema(tontineMembersTable).omit({ id: true, joinedAt: true });
export const insertTontineCycleSchema = createInsertSchema(tontineCyclesTable).omit({ id: true, createdAt: true });
export const insertTontinePaymentSchema = createInsertSchema(tontinePaymentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTontinePayoutSchema = createInsertSchema(tontinePayoutsTable).omit({ id: true, createdAt: true });
export const insertTontinePenaltySchema = createInsertSchema(tontinePenaltiesTable).omit({ id: true, assessedAt: true });

export type Tontine              = typeof tontinesTable.$inferSelect;
export type InsertTontine        = z.infer<typeof insertTontineSchema>;
export type TontineMember        = typeof tontineMembersTable.$inferSelect;
export type InsertTontineMember  = z.infer<typeof insertTontineMemberSchema>;
export type TontineCycle = typeof tontineCyclesTable.$inferSelect;
export type InsertTontineCycle = z.infer<typeof insertTontineCycleSchema>;
export type TontinePayment = typeof tontinePaymentsTable.$inferSelect;
export type InsertTontinePayment = z.infer<typeof insertTontinePaymentSchema>;
export type TontinePayout = typeof tontinePayoutsTable.$inferSelect;
export type InsertTontinePayout = z.infer<typeof insertTontinePayoutSchema>;
export type TontinePenalty = typeof tontinePenaltiesTable.$inferSelect;
export type InsertTontinePenalty = z.infer<typeof insertTontinePenaltySchema>;
