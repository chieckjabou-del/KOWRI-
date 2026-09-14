import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";

// One-time codes sent to a phone number before an account may be created (or
// another sensitive action confirmed). Codes and the verification token handed
// back after a successful check are stored hashed; the plaintext only ever
// travels over SMS and the HTTPS response.
export const phoneVerificationsTable = pgTable("phone_verifications", {
  id:          text("id").primaryKey(),
  phone:       text("phone").notNull(),
  purpose:     text("purpose").notNull().default("registration"),
  codeHash:    text("code_hash").notNull(),
  attempts:    integer("attempts").notNull().default(0),
  expiresAt:   timestamp("expires_at").notNull(),
  verifiedAt:  timestamp("verified_at"),
  tokenHash:   text("token_hash"),
  tokenExpiresAt: timestamp("token_expires_at"),
  consumedAt:  timestamp("consumed_at"),
  requestIp:   text("request_ip"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("phone_verif_phone_idx").on(t.phone),
  index("phone_verif_token_idx").on(t.tokenHash),
  index("phone_verif_expires_idx").on(t.expiresAt),
]);

export type PhoneVerification = typeof phoneVerificationsTable.$inferSelect;
