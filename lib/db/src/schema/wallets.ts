import { pgTable, text, numeric, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const walletStatusEnum = pgEnum("wallet_status", ["active", "frozen", "closed"]);
export const walletTypeEnum = pgEnum("wallet_type", ["personal", "merchant", "savings", "tontine"]);

export const walletsTable = pgTable("wallets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  currency: text("currency").notNull().default("XOF"),
  balance: numeric("balance", { precision: 20, scale: 4 }).notNull().default("0"),
  availableBalance: numeric("available_balance", { precision: 20, scale: 4 }).notNull().default("0"),
  status: walletStatusEnum("status").notNull().default("active"),
  walletType: walletTypeEnum("wallet_type").notNull().default("personal"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertWalletSchema = createInsertSchema(walletsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type Wallet = typeof walletsTable.$inferSelect;
export type InsertWallet = z.infer<typeof insertWalletSchema>;
