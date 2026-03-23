import { pgTable, text, numeric, timestamp, jsonb, pgEnum, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { walletsTable } from "./wallets";

export const transactionTypeEnum = pgEnum("transaction_type", [
  "deposit", "transfer", "loan_disbursement", "loan_repayment",
  "subscription", "tontine_contribution", "tontine_payout", "merchant_payment"
]);

export const transactionStatusEnum = pgEnum("transaction_status", [
  "pending", "processing", "completed", "failed", "reversed"
]);

export const transactionsTable = pgTable("transactions", {
  id: text("id").primaryKey(),
  fromWalletId: text("from_wallet_id").references(() => walletsTable.id),
  toWalletId: text("to_wallet_id").references(() => walletsTable.id),
  amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
  currency: text("currency").notNull().default("XOF"),
  type: transactionTypeEnum("type").notNull(),
  status: transactionStatusEnum("status").notNull().default("pending"),
  reference: text("reference").notNull().unique(),
  description: text("description"),
  metadata: jsonb("metadata"),
  idempotencyKey: text("idempotency_key").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (t) => [
  index("txn_from_wallet_idx").on(t.fromWalletId),
  index("txn_to_wallet_idx").on(t.toWalletId),
  index("txn_created_idx").on(t.createdAt),
  index("txn_status_idx").on(t.status),
]);

export const ledgerEntriesTable = pgTable("ledger_entries", {
  id: text("id").primaryKey(),
  transactionId: text("transaction_id").notNull().references(() => transactionsTable.id),
  accountId: text("account_id").notNull(),
  accountType: text("account_type").notNull(),
  debitAmount: numeric("debit_amount", { precision: 20, scale: 4 }).notNull().default("0"),
  creditAmount: numeric("credit_amount", { precision: 20, scale: 4 }).notNull().default("0"),
  currency: text("currency").notNull(),
  eventType: text("event_type").notNull(),
  description: text("description"),
  entryType: text("entry_type"),
  walletId: text("wallet_id"),
  reference: text("reference"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("ledger_wallet_idx").on(t.walletId),
  index("ledger_account_idx").on(t.accountId),
  index("ledger_created_idx").on(t.createdAt),
  index("ledger_tx_idx").on(t.transactionId),
]);

export const insertTransactionSchema = createInsertSchema(transactionsTable).omit({ id: true, createdAt: true });
export const insertLedgerEntrySchema = createInsertSchema(ledgerEntriesTable).omit({ id: true, createdAt: true });

export type Transaction = typeof transactionsTable.$inferSelect;
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type LedgerEntry = typeof ledgerEntriesTable.$inferSelect;
export type InsertLedgerEntry = z.infer<typeof insertLedgerEntrySchema>;
