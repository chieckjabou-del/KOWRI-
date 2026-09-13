// ── Cash-in maker-checker ────────────────────────────────────────────────────
//
// The only way money is created on the platform. One named operator with
// ledger.write *initiates* a request (wallet, amount, currency, external
// evidence reference); a different named operator with ledger.approve
// *approves* it, and the approval posts the deposit in the same database
// transaction that marks the request EXECUTED. Above a threshold a second,
// distinct approver is required. Every rule below is also enforced by the
// database (migration 0004), so no worker, script, seed or SQL session can
// create money outside this path.
//
// Limits are XOF figures (the reference currency); a request in another
// currency is converted at the published rate when it is initiated. The
// defaults are proposals to be validated by the business, not policy — see
// AKWE_P0_FINANCIAL_CONTROL_GATE.md, "Décisions produit restantes".

import { db } from "@workspace/db";
import { cashInRequestsTable, cashInDecisionsTable, walletsTable, usersTable, transactionsTable, CASH_IN_SOURCES, type CashInRequest, type CashInDecision } from "@workspace/db";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { generateId } from "./id";
import { audit } from "./auditLogger";
import { eventBus } from "./eventBus";
import { toReferenceCurrency } from "./fxEngine";
import { processDeposit, normalizeAmount, withDeadlockRetry, type DbClient } from "./walletService";
import type { AdminIdentity } from "./adminAuth";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

export interface CashInLimits {
  maxPerOperation: number;        // any single request above this is refused
  secondApprovalThreshold: number; // at or above this, two distinct approvers
  dailyPerInitiator: number;      // sum of one operator's live requests per UTC day
  dailyPerBeneficiary: number;    // sum per beneficiary user (all wallets) per UTC day
  dailyPlatform: number;          // sum of all live requests per UTC day
  expiryHours: number;            // a request nobody decided on expires
}

export function cashInLimits(): CashInLimits {
  return {
    maxPerOperation:         envNumber("CASH_IN_MAX_PER_OPERATION", 10_000_000),
    secondApprovalThreshold: envNumber("CASH_IN_SECOND_APPROVAL_THRESHOLD", 1_000_000),
    dailyPerInitiator:       envNumber("CASH_IN_DAILY_LIMIT_PER_OPERATOR", 50_000_000),
    dailyPerBeneficiary:     envNumber("CASH_IN_DAILY_LIMIT_PER_BENEFICIARY", 20_000_000),
    dailyPlatform:           envNumber("CASH_IN_DAILY_LIMIT_PLATFORM", 500_000_000),
    expiryHours:             envNumber("CASH_IN_EXPIRY_HOURS", 24),
  };
}

export class CashInError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "CashInError";
  }
}

const LIVE_STATUSES = ["PENDING_APPROVAL", "APPROVED", "EXECUTED"] as const;

function requireNamedOperator(admin: AdminIdentity, permission: "ledger.write" | "ledger.approve"): void {
  if (admin.via !== "session" || !admin.sessionId) throw new CashInError(403, "SESSION_REQUIRED", "A named operator session is required");
  if (!admin.permissions.has(permission)) throw new CashInError(403, "PERMISSION_DENIED", `Missing permission ${permission}`);
}

function ledgerKey(requestId: string): string { return `cash-in:${requestId}`; }

export function publicCashIn(row: CashInRequest, decisions: CashInDecision[] = []) {
  return {
    id: row.id, walletId: row.walletId, userId: row.userId,
    amount: Number(row.amount), currency: row.currency, amountReference: Number(row.amountReference),
    reference: row.reference, source: row.source, description: row.description,
    status: row.status, approvalsRequired: row.approvalsRequired,
    initiatedBy: row.initiatedBy, initiatedByEmail: row.initiatedByEmail, initiatedAt: row.initiatedAt, expiresAt: row.expiresAt,
    approvedBy: row.approvedBy, approvedAt: row.approvedAt, secondApprovedBy: row.secondApprovedBy, secondApprovedAt: row.secondApprovedAt,
    closedBy: row.closedBy, closedAt: row.closedAt, closeReason: row.closeReason,
    transactionId: row.transactionId, executedAt: row.executedAt,
    warnings: ((row.metadata as any)?.warnings ?? []) as string[],
    decisions: decisions.map((d) => ({ id: d.id, adminId: d.adminId, adminEmail: d.adminEmail, decision: d.decision, reason: d.reason, at: d.createdAt })),
  };
}

async function recordDecision(tx: DbClient, requestId: string, admin: AdminIdentity, decision: string, reason?: string, ip?: string): Promise<void> {
  await tx.insert(cashInDecisionsTable).values({
    id: generateId("cid"), requestId, adminId: admin.adminId, adminEmail: admin.email, decision, reason: reason ?? null, ipAddress: ip ?? null,
  });
}

// ── Initiation ───────────────────────────────────────────────────────────────

export async function initiateCashIn(input: {
  walletId: unknown; amount: unknown; currency: unknown; reference: unknown; source: unknown; description?: unknown;
  initiator: AdminIdentity; ip?: string;
}): Promise<ReturnType<typeof publicCashIn>> {
  const { initiator } = input;
  requireNamedOperator(initiator, "ledger.write");
  const limits = cashInLimits();

  if (typeof input.walletId !== "string" || !input.walletId) throw new CashInError(400, "INVALID_REQUEST", "walletId is required");
  if (typeof input.currency !== "string" || !input.currency) throw new CashInError(400, "INVALID_REQUEST", "currency is required");
  if (typeof input.reference !== "string" || input.reference.trim().length < 4 || input.reference.length > 120) {
    throw new CashInError(400, "INVALID_REQUEST", "reference (external evidence of the funds, 4–120 characters) is required");
  }
  if (typeof input.source !== "string" || !(CASH_IN_SOURCES as readonly string[]).includes(input.source)) {
    throw new CashInError(400, "INVALID_REQUEST", `source must be one of ${CASH_IN_SOURCES.join(", ")}`);
  }
  if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 500)) {
    throw new CashInError(400, "INVALID_REQUEST", "description must be a string of at most 500 characters");
  }
  let amount: number;
  try { amount = normalizeAmount(input.amount); } catch (err: any) { throw new CashInError(400, "INVALID_AMOUNT", err.message); }
  const currency = input.currency.toUpperCase();
  // One piece of evidence, whatever its casing or spacing: "ref 001" and
  // "REF-001 " must not become two requests.
  const reference = input.reference.trim().replace(/\s+/g, " ").toUpperCase();

  const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, input.walletId)).limit(1);
  if (!wallet) throw new CashInError(404, "WALLET_NOT_FOUND", "Wallet not found");
  if (wallet.currency !== currency) throw new CashInError(400, "CURRENCY_MISMATCH", `Wallet is denominated in ${wallet.currency}`);
  if (wallet.status !== "active") throw new CashInError(409, "WALLET_NOT_ACTIVE", `Wallet is ${wallet.status}; cash-in is only allowed on an active wallet`);
  const [user] = await db.select({ status: usersTable.status }).from(usersTable).where(eq(usersTable.id, wallet.userId)).limit(1);
  if (!user) throw new CashInError(404, "USER_NOT_FOUND", "Wallet owner not found");
  if (user.status === "suspended") throw new CashInError(409, "USER_SUSPENDED", "Wallet owner is suspended");

  const amountReference = Math.round((await toReferenceCurrency(amount, currency)) * 10000) / 10000;
  if (amountReference > limits.maxPerOperation) {
    throw new CashInError(409, "CASH_IN_LIMIT_OPERATION", `Amount exceeds the per-operation limit (${limits.maxPerOperation} XOF-equivalent)`);
  }
  const approvalsRequired = amountReference >= limits.secondApprovalThreshold ? 2 : 1;
  const id = generateId("cin");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + limits.expiryHours * 3600_000);

  const row = await withDeadlockRetry(() => db.transaction(async (tx) => {
    // Daily ceilings are read and written under one lock so parallel
    // initiations cannot each pass the check and together exceed it.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('cash-in:daily-limits'))`);
    const [today] = ((await tx.execute(sql`
      SELECT
        COALESCE(SUM(amount_reference) FILTER (WHERE initiated_by = ${initiator.adminId}), 0)::text AS by_initiator,
        COALESCE(SUM(amount_reference) FILTER (WHERE user_id = ${wallet.userId}), 0)::text AS by_beneficiary,
        COALESCE(SUM(amount_reference), 0)::text AS platform
      FROM cash_in_requests
      WHERE status IN ('PENDING_APPROVAL', 'APPROVED', 'EXECUTED')
        AND initiated_at >= date_trunc('day', now() AT TIME ZONE 'utc')`)) as any).rows as Array<{ by_initiator: string; by_beneficiary: string; platform: string }>;
    if (Number(today.by_initiator) + amountReference > limits.dailyPerInitiator) {
      throw new CashInError(409, "CASH_IN_LIMIT_OPERATOR", `Daily limit per operator exceeded (${limits.dailyPerInitiator} XOF-equivalent)`);
    }
    if (Number(today.by_beneficiary) + amountReference > limits.dailyPerBeneficiary) {
      throw new CashInError(409, "CASH_IN_LIMIT_BENEFICIARY", `Daily limit per beneficiary exceeded (${limits.dailyPerBeneficiary} XOF-equivalent)`);
    }
    if (Number(today.platform) + amountReference > limits.dailyPlatform) {
      throw new CashInError(409, "CASH_IN_LIMIT_PLATFORM", `Daily platform cash-in limit exceeded (${limits.dailyPlatform} XOF-equivalent)`);
    }

    // The same evidence can only be credited once, whatever the wallet or amount.
    const [dupRef] = await tx.select({ id: cashInRequestsTable.id, status: cashInRequestsTable.status }).from(cashInRequestsTable)
      .where(eq(cashInRequestsTable.reference, reference)).limit(1);
    if (dupRef) throw new CashInError(409, "CASH_IN_DUPLICATE_REFERENCE", `Reference already used by request ${dupRef.id} (${dupRef.status})`);

    // Same wallet and amount within 24 h under another reference: allowed, but
    // the approver sees it — this is how one real deposit filed twice is caught.
    const similar = await tx.select({ id: cashInRequestsTable.id, status: cashInRequestsTable.status, reference: cashInRequestsTable.reference }).from(cashInRequestsTable)
      .where(and(
        eq(cashInRequestsTable.walletId, wallet.id), eq(cashInRequestsTable.amount, String(amount)),
        inArray(cashInRequestsTable.status, [...LIVE_STATUSES]),
        sql`${cashInRequestsTable.initiatedAt} > now() - interval '24 hours'`,
      )).limit(5);
    const warnings = similar.map((s) => `SIMILAR_REQUEST:${s.id}:${s.status}:${s.reference}`);

    const [inserted] = await tx.insert(cashInRequestsTable).values({
      id, walletId: wallet.id, userId: wallet.userId, amount: String(amount), currency, amountReference: String(amountReference),
      reference, source: input.source as string, description: (input.description as string | undefined) ?? null,
      status: "PENDING_APPROVAL", approvalsRequired,
      initiatedBy: initiator.adminId, initiatedByEmail: initiator.email, initiatedAt: now, expiresAt,
      metadata: { warnings, initiatorRole: initiator.role, mfaVerified: initiator.mfaVerified, ip: input.ip ?? null },
    }).returning();
    await recordDecision(tx as any, id, initiator, "initiate", undefined, input.ip);
    return inserted;
  }));

  await audit({ action: "cash_in.initiated", entity: "cash_in_request", entityId: id, actor: initiator.email,
    metadata: { walletId: wallet.id, userId: wallet.userId, amount, currency, amountReference, reference, approvalsRequired, warnings: (row.metadata as any)?.warnings ?? [] } });
  await eventBus.publish("cash_in.initiated", { requestId: id, walletId: wallet.id, amount, currency, approvalsRequired });
  return publicCashIn(row, await listDecisions(id));
}

// ── Decisions ────────────────────────────────────────────────────────────────

async function lockRequest(tx: DbClient, id: string): Promise<CashInRequest> {
  const res = await tx.execute(sql`SELECT * FROM cash_in_requests WHERE id = ${id} FOR UPDATE`);
  const raw = ((res as any).rows ?? [])[0];
  if (!raw) throw new CashInError(404, "CASH_IN_NOT_FOUND", "Cash-in request not found");
  // Raw row → camelCase through the table's column map.
  const [row] = await tx.select().from(cashInRequestsTable).where(eq(cashInRequestsTable.id, id)).limit(1);
  return row;
}

async function markExpired(tx: DbClient, row: CashInRequest, by: string): Promise<void> {
  await tx.update(cashInRequestsTable)
    .set({ status: "EXPIRED", closedBy: by, closedAt: new Date(), closeReason: `expired at ${row.expiresAt.toISOString()}` })
    .where(eq(cashInRequestsTable.id, row.id));
  await tx.insert(cashInDecisionsTable).values({ id: generateId("cid"), requestId: row.id, adminId: by, adminEmail: by, decision: "expire", reason: "expiry reached before a decision" });
}

function assertOpen(row: CashInRequest): void {
  if (row.status !== "PENDING_APPROVAL" && row.status !== "APPROVED") {
    throw new CashInError(409, `CASH_IN_ALREADY_${row.status}`, `Request is ${row.status}`);
  }
}

export async function approveCashIn(requestId: string, approver: AdminIdentity, opts: { reason?: string; ip?: string } = {}) {
  requireNamedOperator(approver, "ledger.approve");
  const [current] = await db.select().from(cashInRequestsTable).where(eq(cashInRequestsTable.id, requestId)).limit(1);
  if (!current) throw new CashInError(404, "CASH_IN_NOT_FOUND", "Cash-in request not found");
  assertOpen(current);
  if (current.initiatedBy === approver.adminId) throw new CashInError(403, "CASH_IN_SELF_APPROVAL", "The initiator of a request cannot approve it");
  if (current.approvedBy === approver.adminId) throw new CashInError(403, "CASH_IN_SELF_APPROVAL", "The second approval must come from another operator");

  const needsSecond = current.approvalsRequired >= 2 && current.approvedBy === null;
  if (needsSecond) {
    // First of two signatures: no money moves yet.
    const row = await withDeadlockRetry(() => db.transaction(async (tx) => {
      const locked = await lockRequest(tx as any, requestId);
      assertOpen(locked);
      if (locked.expiresAt.getTime() < Date.now()) { await markExpired(tx as any, locked, "system"); throw new CashInError(409, "CASH_IN_EXPIRED", "Request expired before approval"); }
      if (locked.approvedBy !== null) throw new CashInError(409, "CASH_IN_ALREADY_APPROVED", "First approval already recorded; a second approver is needed");
      if (locked.initiatedBy === approver.adminId) throw new CashInError(403, "CASH_IN_SELF_APPROVAL", "The initiator of a request cannot approve it");
      const [updated] = await tx.update(cashInRequestsTable)
        .set({ status: "APPROVED", approvedBy: approver.adminId, approvedAt: new Date() })
        .where(eq(cashInRequestsTable.id, requestId)).returning();
      await recordDecision(tx as any, requestId, approver, "approve", opts.reason, opts.ip);
      return updated;
    }));
    await audit({ action: "cash_in.approved", entity: "cash_in_request", entityId: requestId, actor: approver.email, metadata: { step: 1, of: 2, amount: Number(row.amount), currency: row.currency } });
    return { request: publicCashIn(row, await listDecisions(requestId)), transaction: null };
  }

  // Final approval: the deposit and the EXECUTED mark commit together or not at all.
  const now = new Date();
  let executed: CashInRequest | undefined;
  const transaction = await processDeposit({
    walletId: current.walletId, amount: Number(current.amount), currency: current.currency,
    reference: `CASHIN-${current.id}`, description: current.description ?? `Cash-in ${current.source} ${current.reference}`,
    idempotencyKey: ledgerKey(current.id),
    authority: { kind: "cash_in_request", requestId: current.id },
    attach: async (tx, { transactionId }) => {
      const locked = await lockRequest(tx, requestId);
      assertOpen(locked);
      if (locked.expiresAt.getTime() < Date.now()) throw new CashInError(409, "CASH_IN_EXPIRED", "Request expired before approval");
      if (locked.initiatedBy === approver.adminId || locked.approvedBy === approver.adminId) throw new CashInError(403, "CASH_IN_SELF_APPROVAL", "Approver must differ from initiator and first approver");
      if (locked.approvalsRequired >= 2 && locked.approvedBy === null) throw new CashInError(409, "CASH_IN_NEEDS_FIRST_APPROVAL", "Two signatures are required");
      // The beneficiary is re-checked at execution: a user suspended after the
      // request was filed must not be credited on the strength of the old check.
      const [owner] = await tx.select({ status: usersTable.status }).from(usersTable).where(eq(usersTable.id, locked.userId)).limit(1);
      if (!owner || owner.status === "suspended") throw new CashInError(409, "USER_SUSPENDED", "Beneficiary is suspended; the request cannot be executed");
      // The row is immutable, but the money posted must equal what was approved: re-check against the locked row.
      if (Number(locked.amount) !== Number(current.amount) || locked.walletId !== current.walletId || locked.currency !== current.currency) {
        throw new CashInError(409, "CASH_IN_MISMATCH", "Request changed between read and execution");
      }
      const patch = locked.approvalsRequired >= 2
        ? { secondApprovedBy: approver.adminId, secondApprovedAt: now }
        : { approvedBy: approver.adminId, approvedAt: now };
      const [updated] = await tx.update(cashInRequestsTable)
        .set({ ...patch, status: "EXECUTED", transactionId, executedAt: now })
        .where(eq(cashInRequestsTable.id, requestId)).returning();
      await recordDecision(tx, requestId, approver, "approve", opts.reason, opts.ip);
      executed = updated;
    },
  });

  await audit({ action: "cash_in.executed", entity: "cash_in_request", entityId: requestId, actor: approver.email,
    metadata: { transactionId: transaction.id, walletId: current.walletId, amount: Number(current.amount), currency: current.currency, approvalsRequired: current.approvalsRequired } });
  await eventBus.publish("cash_in.executed", { requestId, transactionId: transaction.id, walletId: current.walletId, amount: Number(current.amount), currency: current.currency });
  const row = executed ?? (await db.select().from(cashInRequestsTable).where(eq(cashInRequestsTable.id, requestId)).limit(1))[0];
  return { request: publicCashIn(row, await listDecisions(requestId)), transaction: { ...transaction, amount: Number(transaction.amount) } };
}

export async function rejectCashIn(requestId: string, admin: AdminIdentity, opts: { reason?: string; ip?: string } = {}) {
  requireNamedOperator(admin, "ledger.approve");
  if (typeof opts.reason !== "string" || opts.reason.trim().length < 3) throw new CashInError(400, "INVALID_REQUEST", "A reason is required to reject");
  const row = await withDeadlockRetry(() => db.transaction(async (tx) => {
    const locked = await lockRequest(tx as any, requestId);
    assertOpen(locked);
    const [updated] = await tx.update(cashInRequestsTable)
      .set({ status: "REJECTED", closedBy: admin.adminId, closedAt: new Date(), closeReason: opts.reason!.trim() })
      .where(eq(cashInRequestsTable.id, requestId)).returning();
    await recordDecision(tx as any, requestId, admin, "reject", opts.reason, opts.ip);
    return updated;
  }));
  await audit({ action: "cash_in.rejected", entity: "cash_in_request", entityId: requestId, actor: admin.email, metadata: { reason: opts.reason, amount: Number(row.amount), currency: row.currency } });
  return publicCashIn(row, await listDecisions(requestId));
}

// The initiator withdraws their own request; an approver can also cancel one.
export async function cancelCashIn(requestId: string, admin: AdminIdentity, opts: { reason?: string; ip?: string } = {}) {
  if (admin.via !== "session" || !admin.sessionId) throw new CashInError(403, "SESSION_REQUIRED", "A named operator session is required");
  const row = await withDeadlockRetry(() => db.transaction(async (tx) => {
    const locked = await lockRequest(tx as any, requestId);
    assertOpen(locked);
    const own = locked.initiatedBy === admin.adminId && admin.permissions.has("ledger.write");
    if (!own && !admin.permissions.has("ledger.approve")) throw new CashInError(403, "PERMISSION_DENIED", "Only the initiator or an approver can cancel a request");
    const [updated] = await tx.update(cashInRequestsTable)
      .set({ status: "CANCELLED", closedBy: admin.adminId, closedAt: new Date(), closeReason: opts.reason?.trim() || "cancelled" })
      .where(eq(cashInRequestsTable.id, requestId)).returning();
    await recordDecision(tx as any, requestId, admin, "cancel", opts.reason, opts.ip);
    return updated;
  }));
  await audit({ action: "cash_in.cancelled", entity: "cash_in_request", entityId: requestId, actor: admin.email, metadata: { reason: opts.reason ?? null } });
  return publicCashIn(row, await listDecisions(requestId));
}

// Scheduler: a request nobody decided on is closed; it can never be executed afterwards.
export async function expireCashInRequests(): Promise<number> {
  const due = await db.select({ id: cashInRequestsTable.id }).from(cashInRequestsTable)
    .where(and(inArray(cashInRequestsTable.status, ["PENDING_APPROVAL", "APPROVED"]), sql`${cashInRequestsTable.expiresAt} < now()`)).limit(500);
  let n = 0;
  for (const { id } of due) {
    try {
      await db.transaction(async (tx) => {
        const locked = await lockRequest(tx as any, id);
        if (locked.status !== "PENDING_APPROVAL" && locked.status !== "APPROVED") return;
        if (locked.expiresAt.getTime() >= Date.now()) return;
        await markExpired(tx as any, locked, "system");
        n += 1;
      });
      await audit({ action: "cash_in.expired", entity: "cash_in_request", entityId: id, actor: "system" });
    } catch (err) {
      console.error(`[CashIn] failed to expire ${id}:`, err);
    }
  }
  return n;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listDecisions(requestId: string): Promise<CashInDecision[]> {
  return db.select().from(cashInDecisionsTable).where(eq(cashInDecisionsTable.requestId, requestId)).orderBy(cashInDecisionsTable.createdAt);
}

export async function getCashIn(requestId: string) {
  const [row] = await db.select().from(cashInRequestsTable).where(eq(cashInRequestsTable.id, requestId)).limit(1);
  if (!row) return null;
  const out = publicCashIn(row, await listDecisions(requestId));
  const tx = row.transactionId ? (await db.select().from(transactionsTable).where(eq(transactionsTable.id, row.transactionId)).limit(1))[0] : null;
  return { ...out, transaction: tx ? { id: tx.id, status: tx.status, amount: Number(tx.amount), currency: tx.currency, reference: tx.reference, completedAt: tx.completedAt } : null };
}

export async function listCashIn(filter: { status?: string; walletId?: string; initiatedBy?: string; limit?: number } = {}) {
  const conds = [];
  if (filter.status) conds.push(eq(cashInRequestsTable.status, filter.status));
  if (filter.walletId) conds.push(eq(cashInRequestsTable.walletId, filter.walletId));
  if (filter.initiatedBy) conds.push(eq(cashInRequestsTable.initiatedBy, filter.initiatedBy));
  const rows = await db.select().from(cashInRequestsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(cashInRequestsTable.initiatedAt))
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200));
  return rows.map((r) => publicCashIn(r));
}
