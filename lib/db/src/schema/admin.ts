import { pgTable, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

// Back-office operators. Distinct from product users: an admin never owns a
// wallet, and a wallet user never gains back-office rights by accident.
export const adminUsersTable = pgTable("admin_users", {
  id:           text("id").primaryKey(),
  email:        text("email").notNull().unique(),
  name:         text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role:         text("role").notNull().default("support"),
  status:       text("status").notNull().default("active"), // active | disabled
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  // TOTP second factor. The secret is stored encrypted (lib/fieldCrypto.ts);
  // mfa_enabled_at is null until the operator has confirmed a first code.
  mfaSecret:    text("mfa_secret"),
  mfaEnabledAt: timestamp("mfa_enabled_at"),
  lastLoginAt:  timestamp("last_login_at"),
  createdBy:    text("created_by"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
  updatedAt:    timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("admin_users_role_idx").on(t.role),
]);

export const adminSessionsTable = pgTable("admin_sessions", {
  id:          text("id").primaryKey(),
  adminUserId: text("admin_user_id").notNull(),
  tokenHash:   text("token_hash").notNull().unique(),
  ipAddress:   text("ip_address"),
  userAgent:   text("user_agent"),
  expiresAt:   timestamp("expires_at").notNull(),
  revokedAt:   timestamp("revoked_at"),
  // True once the second factor was presented for this session. Sessions
  // without it only carry read permissions when MFA is enforced.
  mfaVerified: boolean("mfa_verified").notNull().default(false),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  lastUsedAt:  timestamp("last_used_at").notNull().defaultNow(),
}, (t) => [
  index("admin_sessions_admin_idx").on(t.adminUserId),
]);
