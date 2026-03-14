import { pgTable, text, numeric, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { walletsTable } from "./wallets";

export const merchantStatusEnum = pgEnum("merchant_status", ["active", "suspended", "pending_approval"]);

export const merchantsTable = pgTable("merchants", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  businessName: text("business_name").notNull(),
  businessType: text("business_type").notNull(),
  status: merchantStatusEnum("status").notNull().default("pending_approval"),
  walletId: text("wallet_id").notNull().references(() => walletsTable.id),
  apiKey: text("api_key").unique(),
  country: text("country").notNull(),
  totalRevenue: numeric("total_revenue", { precision: 20, scale: 4 }).notNull().default("0"),
  transactionCount: integer("transaction_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertMerchantSchema = createInsertSchema(merchantsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type Merchant = typeof merchantsTable.$inferSelect;
export type InsertMerchant = z.infer<typeof insertMerchantSchema>;
