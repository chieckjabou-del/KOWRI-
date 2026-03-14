import { pgTable, text, numeric, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { walletsTable } from "./wallets";

export const tontineStatusEnum = pgEnum("tontine_status", ["active", "completed", "pending"]);
export const tontineFrequencyEnum = pgEnum("tontine_frequency", ["weekly", "biweekly", "monthly"]);

export const tontinesTable = pgTable("tontines", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  contributionAmount: numeric("contribution_amount", { precision: 20, scale: 4 }).notNull(),
  currency: text("currency").notNull().default("XOF"),
  frequency: tontineFrequencyEnum("frequency").notNull(),
  maxMembers: integer("max_members").notNull(),
  memberCount: integer("member_count").notNull().default(0),
  currentRound: integer("current_round").notNull().default(0),
  totalRounds: integer("total_rounds").notNull(),
  status: tontineStatusEnum("status").notNull().default("pending"),
  adminUserId: text("admin_user_id").notNull().references(() => usersTable.id),
  walletId: text("wallet_id").references(() => walletsTable.id),
  nextPayoutDate: timestamp("next_payout_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const tontineMembersTable = pgTable("tontine_members", {
  id: text("id").primaryKey(),
  tontineId: text("tontine_id").notNull().references(() => tontinesTable.id),
  userId: text("user_id").notNull().references(() => usersTable.id),
  payoutOrder: integer("payout_order").notNull(),
  hasReceivedPayout: integer("has_received_payout").notNull().default(0),
  contributionsCount: integer("contributions_count").notNull().default(0),
  joinedAt: timestamp("joined_at").notNull().defaultNow(),
});

export const insertTontineSchema = createInsertSchema(tontinesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTontineMemberSchema = createInsertSchema(tontineMembersTable).omit({ id: true, joinedAt: true });

export type Tontine = typeof tontinesTable.$inferSelect;
export type InsertTontine = z.infer<typeof insertTontineSchema>;
export type TontineMember = typeof tontineMembersTable.$inferSelect;
export type InsertTontineMember = z.infer<typeof insertTontineMemberSchema>;
