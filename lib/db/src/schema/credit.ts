import { pgTable, text, numeric, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { walletsTable } from "./wallets";

export const creditTierEnum = pgEnum("credit_tier", ["bronze", "silver", "gold", "platinum"]);
export const loanStatusEnum = pgEnum("loan_status", ["pending", "approved", "disbursed", "repaid", "defaulted"]);

export const creditScoresTable = pgTable("credit_scores", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id).unique(),
  score: integer("score").notNull().default(300),
  tier: creditTierEnum("tier").notNull().default("bronze"),
  maxLoanAmount: numeric("max_loan_amount", { precision: 20, scale: 4 }).notNull().default("0"),
  interestRate: numeric("interest_rate", { precision: 5, scale: 2 }).notNull().default("15"),
  paymentHistory: integer("payment_history").notNull().default(0),
  savingsRegularity: integer("savings_regularity").notNull().default(0),
  transactionVolume: integer("transaction_volume").notNull().default(0),
  tontineParticipation: integer("tontine_participation").notNull().default(0),
  networkScore: integer("network_score").notNull().default(0),
  lastUpdated: timestamp("last_updated").notNull().defaultNow(),
});

export const loansTable = pgTable("loans", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  walletId: text("wallet_id").notNull().references(() => walletsTable.id),
  amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
  currency: text("currency").notNull().default("XOF"),
  interestRate: numeric("interest_rate", { precision: 5, scale: 2 }).notNull(),
  termDays: integer("term_days").notNull(),
  status: loanStatusEnum("status").notNull().default("pending"),
  amountRepaid: numeric("amount_repaid", { precision: 20, scale: 4 }).notNull().default("0"),
  purpose: text("purpose"),
  dueDate: timestamp("due_date"),
  disbursedAt: timestamp("disbursed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCreditScoreSchema = createInsertSchema(creditScoresTable).omit({ id: true, lastUpdated: true });
export const insertLoanSchema = createInsertSchema(loansTable).omit({ id: true, createdAt: true, updatedAt: true });

export type CreditScore = typeof creditScoresTable.$inferSelect;
export type InsertCreditScore = z.infer<typeof insertCreditScoreSchema>;
export type Loan = typeof loansTable.$inferSelect;
export type InsertLoan = z.infer<typeof insertLoanSchema>;
