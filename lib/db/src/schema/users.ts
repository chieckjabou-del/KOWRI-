import { pgTable, text, integer, timestamp, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const userStatusEnum = pgEnum("user_status", ["active", "suspended", "pending_kyc"]);
export const kycStatusEnum = pgEnum("kyc_status", ["pending", "verified", "rejected", "expired"]);
export const documentTypeEnum = pgEnum("document_type", ["national_id", "passport", "drivers_license"]);

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  phone: text("phone").notNull().unique(),
  email: text("email"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  status: userStatusEnum("status").notNull().default("pending_kyc"),
  kycLevel: integer("kyc_level").notNull().default(0),
  country: text("country").notNull(),
  pinHash: text("pin_hash").notNull(),
  ratingScore: integer("rating_score").notNull().default(100),
  creditScore: integer("credit_score"),
  isActive: boolean("is_active").notNull().default(true),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const kycRecordsTable = pgTable("kyc_records", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  documentType: documentTypeEnum("document_type").notNull(),
  status: kycStatusEnum("status").notNull().default("pending"),
  kycLevel: integer("kyc_level").notNull().default(1),
  documentNumber: text("document_number"),
  fullName: text("full_name"),
  dateOfBirth: text("date_of_birth"),
  documentFront: text("document_front"),
  selfie: text("selfie"),
  proofOfAddress: text("proof_of_address"),
  secondDocument: text("second_document"),
  rejectionReason: text("rejection_reason"),
  verifiedAt: timestamp("verified_at"),
  submittedAt: timestamp("submitted_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertKycRecordSchema = createInsertSchema(kycRecordsTable).omit({ id: true, submittedAt: true });

export type User = typeof usersTable.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type KycRecord = typeof kycRecordsTable.$inferSelect;
export type InsertKycRecord = z.infer<typeof insertKycRecordSchema>;
