import { pgTable, text, numeric, timestamp, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";

// ── Cash-in requests (maker-checker) ─────────────────────────────────────────
//
// Money enters the platform only through a request that one operator
// initiates and a *different* operator approves. The request row is the
// authority for the ledger movement: the deposit transaction references it,
// and the database refuses a deposit whose request is not EXECUTED with that
// very transaction id (see migration 0004, transactions_deposit_authority).
//
// Lifecycle:
//   PENDING_APPROVAL ─┬─► EXECUTED     (single approval: approve + post, one transaction)
//                     ├─► APPROVED ──► EXECUTED   (two approvals above the threshold)
//                     ├─► REJECTED    (checker refuses)
//                     ├─► CANCELLED   (initiator withdraws, or a checker cancels)
//                     └─► EXPIRED     (nobody decided before expires_at)
// Terminal rows (EXECUTED/REJECTED/CANCELLED/EXPIRED) never change again.

export const CASH_IN_STATUSES = ["PENDING_APPROVAL", "APPROVED", "EXECUTED", "REJECTED", "CANCELLED", "EXPIRED"] as const;
export type CashInStatus = (typeof CASH_IN_STATUSES)[number];

export const CASH_IN_SOURCES = ["bank_transfer", "agent_cash", "mobile_money", "correction", "test_funding", "other"] as const;
export type CashInSource = (typeof CASH_IN_SOURCES)[number];

export const cashInRequestsTable = pgTable("cash_in_requests", {
  id:               text("id").primaryKey(),
  walletId:         text("wallet_id").notNull(),
  userId:           text("user_id").notNull(),
  amount:           numeric("amount", { precision: 20, scale: 4 }).notNull(),
  currency:         text("currency").notNull(),
  // Value in the reference currency (XOF) at initiation, used for every limit.
  amountReference:  numeric("amount_reference", { precision: 20, scale: 4 }).notNull(),
  // External evidence of the funds (bank slip, agent receipt, provider id). Unique:
  // one piece of evidence can only ever be credited once.
  reference:        text("reference").notNull(),
  source:           text("source").notNull(),
  description:      text("description"),
  status:           text("status").notNull().default("PENDING_APPROVAL"),
  approvalsRequired: integer("approvals_required").notNull().default(1),
  initiatedBy:      text("initiated_by").notNull(),
  initiatedByEmail: text("initiated_by_email").notNull(),
  initiatedAt:      timestamp("initiated_at").notNull().defaultNow(),
  expiresAt:        timestamp("expires_at").notNull(),
  approvedBy:       text("approved_by"),
  approvedAt:       timestamp("approved_at"),
  secondApprovedBy: text("second_approved_by"),
  secondApprovedAt: timestamp("second_approved_at"),
  closedBy:         text("closed_by"),
  closedAt:         timestamp("closed_at"),
  closeReason:      text("close_reason"),
  transactionId:    text("transaction_id"),
  executedAt:       timestamp("executed_at"),
  metadata:         jsonb("metadata"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
  updatedAt:        timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("cash_in_reference_uidx").on(t.reference),
  uniqueIndex("cash_in_transaction_uidx").on(t.transactionId),
  index("cash_in_status_idx").on(t.status),
  index("cash_in_initiator_idx").on(t.initiatedBy, t.initiatedAt),
  index("cash_in_wallet_idx").on(t.walletId, t.initiatedAt),
]);

// Append-only trail of every decision taken on a request, by whom and from where.
export const cashInDecisionsTable = pgTable("cash_in_decisions", {
  id:         text("id").primaryKey(),
  requestId:  text("request_id").notNull(),
  adminId:    text("admin_id").notNull(),
  adminEmail: text("admin_email").notNull(),
  decision:   text("decision").notNull(), // initiate | approve | reject | cancel | expire
  reason:     text("reason"),
  ipAddress:  text("ip_address"),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("cash_in_decisions_request_idx").on(t.requestId),
]);

export type CashInRequest = typeof cashInRequestsTable.$inferSelect;
export type CashInDecision = typeof cashInDecisionsTable.$inferSelect;
