// ── Financial reconciliation ─────────────────────────────────────────────────
//
// One report that answers, for every currency: how much money the platform
// holds for users, where it sits (wallets, treasury, agent float), whether the
// ledger is internally consistent, and what is stuck in flight. Every check is
// a SQL query against the ledger — the source of truth — never against cached
// balances. Anomalies are returned as a list an operator can act on and, when
// the report runs on the scheduler, logged as incidents so they are never
// silent.
//
// Checks (each maps to an invariant of the money model):
//   I1  every transaction balances per currency (sum debits = sum credits)
//   I2  no ledger entry is negative or carries both sides (or neither)
//   I3  no wallet account is overdrawn in the ledger
//   I4  the materialised wallet balance equals the ledger balance
//   I5  no transaction is stuck in pending/processing
//   I6  no float transfer is stuck PENDING (agent float ≠ ledger)
//   I7  no completed transaction lacks its ledger entries
//   I8  no published FX pair allows a profitable round trip
//   I9  no idempotency reservation is stuck in flight (crash marker)
//   I10 every deposit names a known authority; non-production authorities
//       (treasury_seed, demo_seed, legacy_pre_gate) never appear in production
//   I11 money created under cash-in authority equals the sum of EXECUTED
//       cash-in requests, and every EXECUTED request has its completed transaction
//   I12 no cash-in request is past its expiry and still open (expiry job alive)
//   I13 conservation: for each currency, user liabilities + treasury + platform
//       fees + platform FX = money created − money destroyed (Σ platform_float)
//   I14 a tontine's solidarity reserve never exceeds the money in its wallet
//   I15 an investment pool's booked amount equals its active positions and is
//       covered by its wallet
//   I16 a cached idempotent money response always names an existing transaction
//   Not assertable today (documented gap): agent float (agent_wallets.float_balance)
//   has no ledger account behind it — see the gate report, "Agents".
//
// Money model, per currency (all figures read from ledger_entries):
//   created   = Σ debits of platform_float  (cash-in, yield, non-prod seeds)
//   destroyed = Σ credits of platform_float (cash-out, reversals of deposits)
//   supply    = created − destroyed = Σ balances of every non-float account
//   supply    = userLiabilities + treasury + platformFees + platformFx
// A breach of I13 means an account exists outside the model or an entry was
// written outside double entry; I1/I2 point at the offending transaction.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { findArbitragePairs } from "./fxEngine";
import { TREASURY_USER_ID } from "./treasury";
import { getOutboxStats } from "./outboxWorker";
import { logIncident } from "./incidentStore";
import { audit } from "./auditLogger";

const STUCK_TX_MINUTES = 5;
const STUCK_FLOAT_MINUTES = 2;
const STUCK_IDEMPOTENCY_HOURS = 1;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const r = await db.execute(query);
  return ((r as any).rows ?? []) as T[];
}

export interface FinancialReport {
  generatedAt: string;
  ok: boolean;
  anomalies: string[];
  supply: Array<{
    currency: string; userLiabilities: number; treasury: number; platformFloat: number; platformFees: number; platformFx: number; agentFloat: number;
    created: number; destroyed: number; createdByAuthority: Record<string, number>; conservationGap: number;
  }>;
  cashIn: { executedTotal: Record<string, number>; open: number; overdueOpen: number; ledgerMismatch: Array<{ requestId: string; reason: string }> };
  checks: {
    depositsWithoutAuthority: number;
    depositsNonProductionAuthority: number;
    tontineReserveOverdrawn: Array<{ tontineId: string; reserve: number; walletBalance: number }>;
    poolMismatch: Array<{ poolId: string; reason: string }>;
    idempotencyOrphans: number;
    unbalancedTransactions: Array<{ transactionId: string; currency: string; debit: number; credit: number }>;
    malformedEntries: number;
    overdrawnWallets: Array<{ walletId: string; currency: string; balance: number }>;
    balanceDrift: Array<{ walletId: string; stored: number; derived: number }>;
    stuckTransactions: Array<{ id: string; status: string; ageMinutes: number }>;
    stuckFloatTransfers: Array<{ id: string; fromAgentId: string | null; toAgentId: string | null; amount: number; ageMinutes: number }>;
    completedWithoutEntries: number;
    fxArbitrage: Array<{ from: string; to: string; product: number }>;
    stuckIdempotency: number;
    outbox: { pending: number; processing: number; dead: number };
    sagas: { failed24h: number; compensated24h: number };
    loans: Array<{ currency: string; outstandingPrincipal: number; activeLoans: number }>;
  };
}

export async function runFinancialReconciliation(): Promise<FinancialReport> {
  const anomalies: string[] = [];

  const unbalanced = await rows<{ transaction_id: string; currency: string; d: string; c: string }>(sql`
    SELECT transaction_id, currency, SUM(debit_amount) AS d, SUM(credit_amount) AS c
    FROM ledger_entries GROUP BY transaction_id, currency
    HAVING SUM(debit_amount) <> SUM(credit_amount) LIMIT 50`);
  if (unbalanced.length) anomalies.push(`I1 ${unbalanced.length} transaction(s) with debits ≠ credits`);

  const [malformed] = await rows<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM ledger_entries
    WHERE debit_amount < 0 OR credit_amount < 0 OR (debit_amount > 0) = (credit_amount > 0)`);
  if (Number(malformed?.n) > 0) anomalies.push(`I2 ${malformed.n} ledger entr(y/ies) negative, two-sided or empty`);

  const overdrawn = await rows<{ wallet_id: string; currency: string; bal: string }>(sql`
    SELECT w.id AS wallet_id, w.currency, COALESCE(l.bal, 0)::text AS bal
    FROM wallets w
    JOIN LATERAL (SELECT SUM(credit_amount) - SUM(debit_amount) AS bal FROM ledger_entries
                  WHERE account_id = w.id AND account_type = 'wallet' AND currency = w.currency) l ON true
    WHERE COALESCE(l.bal, 0) < 0 LIMIT 50`);
  if (overdrawn.length) anomalies.push(`I3 ${overdrawn.length} wallet(s) overdrawn in the ledger`);

  const drift = await rows<{ wallet_id: string; stored: string; derived: string }>(sql`
    SELECT w.id AS wallet_id, w.balance::text AS stored, COALESCE(l.bal, 0)::text AS derived
    FROM wallets w
    LEFT JOIN LATERAL (SELECT SUM(credit_amount) - SUM(debit_amount) AS bal FROM ledger_entries
                       WHERE account_id = w.id AND account_type = 'wallet' AND currency = w.currency) l ON true
    WHERE ABS(w.balance - COALESCE(l.bal, 0)) > 0.0001 LIMIT 50`);
  if (drift.length) anomalies.push(`I4 ${drift.length} wallet(s) whose stored balance differs from the ledger`);

  const stuckTx = await rows<{ id: string; status: string; age: string }>(sql`
    SELECT id, status, EXTRACT(EPOCH FROM (now() - created_at))/60 AS age FROM transactions
    WHERE status IN ('pending', 'processing') AND created_at < now() - (${STUCK_TX_MINUTES} || ' minutes')::interval LIMIT 50`);
  if (stuckTx.length) anomalies.push(`I5 ${stuckTx.length} transaction(s) pending/processing for more than ${STUCK_TX_MINUTES} min`);

  const stuckFloat = await rows<{ id: string; from_agent_id: string | null; to_agent_id: string | null; amount: string; age: string }>(sql`
    SELECT id, from_agent_id, to_agent_id, amount::text, EXTRACT(EPOCH FROM (now() - created_at))/60 AS age FROM liquidity_transfers
    WHERE status = 'PENDING' AND created_at < now() - (${STUCK_FLOAT_MINUTES} || ' minutes')::interval LIMIT 50`);
  if (stuckFloat.length) anomalies.push(`I6 ${stuckFloat.length} float transfer(s) PENDING for more than ${STUCK_FLOAT_MINUTES} min`);

  const [noEntries] = await rows<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM transactions t
    WHERE t.status = 'completed' AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.transaction_id = t.id)`);
  if (Number(noEntries?.n) > 0) anomalies.push(`I7 ${noEntries.n} completed transaction(s) without ledger entries`);

  const fxArbitrage = await findArbitragePairs();
  if (fxArbitrage.length) anomalies.push(`I8 ${fxArbitrage.length} FX pair(s) allow a profitable round trip`);

  const [stuckIdem] = await rows<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM idempotency_keys
    WHERE response_body @> '{"__pending": true}'::jsonb AND created_at < now() - (${STUCK_IDEMPOTENCY_HOURS} || ' hours')::interval`);
  if (Number(stuckIdem?.n) > 0) anomalies.push(`I9 ${stuckIdem.n} idempotency reservation(s) stuck in flight (interrupted requests)`);

  // I10 — deposit authority
  const [noAuthority] = await rows<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM transactions
    WHERE type = 'deposit' AND COALESCE(metadata->>'authority', '') NOT IN ('cash_in_request', 'savings_yield', 'treasury_seed', 'demo_seed', 'reversal', 'legacy_pre_gate')`);
  if (Number(noAuthority?.n) > 0) anomalies.push(`I10 ${noAuthority.n} deposit(s) without a known authority`);
  const [nonProd] = await rows<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM transactions
    WHERE type = 'deposit' AND metadata->>'authority' IN ('treasury_seed', 'demo_seed', 'legacy_pre_gate')`);
  if (process.env.NODE_ENV === "production" && Number(nonProd?.n) > 0) {
    anomalies.push(`I10 ${nonProd.n} deposit(s) created under a non-production authority (seed/legacy) in production`);
  }

  // I11 — cash-in ledger equality
  const cashInLedger = await rows<{ currency: string; total: string }>(sql`
    SELECT currency, COALESCE(SUM(amount), 0)::text AS total FROM transactions
    WHERE type = 'deposit' AND metadata->>'authority' = 'cash_in_request' AND status IN ('completed', 'reversed') GROUP BY currency`);
  const cashInExecuted = await rows<{ currency: string; total: string }>(sql`
    SELECT currency, COALESCE(SUM(amount), 0)::text AS total FROM cash_in_requests WHERE status = 'EXECUTED' GROUP BY currency`);
  const executedTotal: Record<string, number> = {};
  for (const r of cashInExecuted) executedTotal[r.currency] = Number(r.total);
  const ledgerTotal: Record<string, number> = {};
  for (const r of cashInLedger) ledgerTotal[r.currency] = Number(r.total);
  for (const cur of new Set([...Object.keys(executedTotal), ...Object.keys(ledgerTotal)])) {
    if (Math.abs((executedTotal[cur] ?? 0) - (ledgerTotal[cur] ?? 0)) > 0.0001) {
      anomalies.push(`I11 cash-in ${cur}: requests EXECUTED ${executedTotal[cur] ?? 0} ≠ ledger deposits ${ledgerTotal[cur] ?? 0}`);
    }
  }
  const cashInMismatch = await rows<{ id: string; reason: string }>(sql`
    SELECT r.id, CASE WHEN t.id IS NULL THEN 'no transaction' WHEN t.status <> 'completed' THEN 'transaction ' || t.status
                      WHEN t.amount <> r.amount OR t.currency <> r.currency OR t.to_wallet_id IS DISTINCT FROM r.wallet_id THEN 'transaction differs'
                      WHEN COALESCE(t.metadata->>'cashInRequestId', '') <> r.id THEN 'transaction does not point back' END AS reason
    FROM cash_in_requests r LEFT JOIN transactions t ON t.id = r.transaction_id
    WHERE r.status = 'EXECUTED' AND (t.id IS NULL OR t.status <> 'completed' OR t.amount <> r.amount OR t.currency <> r.currency
          OR t.to_wallet_id IS DISTINCT FROM r.wallet_id OR COALESCE(t.metadata->>'cashInRequestId', '') <> r.id) LIMIT 50`);
  if (cashInMismatch.length) anomalies.push(`I11 ${cashInMismatch.length} EXECUTED cash-in request(s) whose ledger transaction is missing or differs`);
  const [orphanCashInTx] = await rows<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM transactions t
    WHERE t.type = 'deposit' AND t.metadata->>'authority' = 'cash_in_request'
      AND NOT EXISTS (SELECT 1 FROM cash_in_requests r WHERE r.id = t.metadata->>'cashInRequestId' AND r.transaction_id = t.id AND r.status = 'EXECUTED')`);
  if (Number(orphanCashInTx?.n) > 0) anomalies.push(`I11 ${orphanCashInTx.n} cash-in deposit(s) without an EXECUTED request pointing at them`);

  // I14 — a tontine's solidarity reserve is money it actually holds
  const reserveOver = await rows<{ id: string; reserve: string; bal: string }>(sql`
    SELECT t.id, t.solidarity_reserve::text AS reserve, COALESCE(l.bal, 0)::text AS bal
    FROM tontines t
    LEFT JOIN LATERAL (SELECT SUM(credit_amount) - SUM(debit_amount) AS bal FROM ledger_entries
                       WHERE account_id = t.wallet_id AND account_type = 'wallet') l ON true
    WHERE t.wallet_id IS NOT NULL AND t.solidarity_reserve > COALESCE(l.bal, 0) + 0.0001 LIMIT 50`);
  if (reserveOver.length) anomalies.push(`I14 ${reserveOver.length} tontine(s) whose solidarity reserve exceeds the money in their wallet`);

  // I15 — investment pools: the booked amount equals the sum of active positions and is backed by the pool wallet
  const poolMismatch = await rows<{ id: string; reason: string }>(sql`
    SELECT p.id, CASE WHEN ABS(p.current_amount - COALESCE(s.tot, 0)) > 0.0001 THEN 'positions ≠ current_amount' ELSE 'wallet holds less than current_amount' END AS reason
    FROM investment_pools p
    LEFT JOIN (SELECT pool_id, SUM(invested_amount) AS tot FROM pool_positions WHERE status = 'active' GROUP BY pool_id) s ON s.pool_id = p.id
    LEFT JOIN LATERAL (SELECT SUM(credit_amount) - SUM(debit_amount) AS bal FROM ledger_entries
                       WHERE account_id = p.wallet_id AND account_type = 'wallet') l ON true
    WHERE ABS(p.current_amount - COALESCE(s.tot, 0)) > 0.0001 OR p.current_amount > COALESCE(l.bal, 0) + 0.0001 LIMIT 50`);
  if (poolMismatch.length) anomalies.push(`I15 ${poolMismatch.length} investment pool(s) whose booked amount disagrees with positions or wallet`);

  // I16 — a cached money response always points at a transaction that exists
  const [idemOrphans] = await rows<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM idempotency_keys k
    WHERE k.endpoint LIKE 'POST:/api/wallets/%/transfer|%'
      AND k.response_body ? 'body' AND (k.response_body->'body'->>'id') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = k.response_body->'body'->>'id')`);
  if (Number(idemOrphans?.n) > 0) anomalies.push(`I16 ${idemOrphans.n} idempotency response(s) referencing a transaction that does not exist`);

  // I12 — expiry job alive
  const [cashInOpen] = await rows<{ open: string; overdue: string }>(sql`
    SELECT COUNT(*) FILTER (WHERE status IN ('PENDING_APPROVAL', 'APPROVED'))::text AS open,
           COUNT(*) FILTER (WHERE status IN ('PENDING_APPROVAL', 'APPROVED') AND expires_at < now() - interval '1 hour')::text AS overdue
    FROM cash_in_requests`);
  if (Number(cashInOpen?.overdue) > 0) anomalies.push(`I12 ${cashInOpen.overdue} cash-in request(s) past expiry for over an hour and still open`);

  const supplyRows = await rows<{ currency: string; account_id: string; account_type: string; bal: string }>(sql`
    SELECT currency, account_id, account_type, (SUM(credit_amount) - SUM(debit_amount))::text AS bal
    FROM ledger_entries GROUP BY currency, account_id, account_type`);
  const treasuryWallets = await rows<{ id: string }>(sql`SELECT id FROM wallets WHERE user_id = ${TREASURY_USER_ID}`);
  const treasuryIds = new Set(treasuryWallets.map((w) => w.id));
  const agentFloat = await rows<{ currency: string; total: string }>(sql`
    SELECT 'XOF' AS currency, COALESCE(SUM(float_balance), 0)::text AS total FROM agent_wallets`);
  const floatFlows = await rows<{ currency: string; created: string; destroyed: string }>(sql`
    SELECT currency, COALESCE(SUM(debit_amount), 0)::text AS created, COALESCE(SUM(credit_amount), 0)::text AS destroyed
    FROM ledger_entries WHERE account_id = 'platform_float' GROUP BY currency`);
  const createdByAuthority = await rows<{ currency: string; authority: string; total: string }>(sql`
    SELECT l.currency, COALESCE(t.metadata->>'authority', 'unknown') AS authority, COALESCE(SUM(l.debit_amount), 0)::text AS total
    FROM ledger_entries l JOIN transactions t ON t.id = l.transaction_id
    WHERE l.account_id = 'platform_float' AND l.debit_amount > 0 GROUP BY l.currency, authority`);
  const otherAccounts = await rows<{ currency: string; account_id: string; bal: string }>(sql`
    SELECT currency, account_id, (SUM(credit_amount) - SUM(debit_amount))::text AS bal FROM ledger_entries
    WHERE account_type <> 'wallet' AND account_id NOT IN ('platform_float', 'platform_fees', 'platform_fx') GROUP BY currency, account_id`);
  if (otherAccounts.length) anomalies.push(`I13 ${otherAccounts.length} ledger account(s) outside the money model: ${otherAccounts.map((o) => o.account_id).join(", ")}`);

  const supplyByCurrency = new Map<string, FinancialReport["supply"][number]>();
  const blank = (currency: string): FinancialReport["supply"][number] => ({ currency, userLiabilities: 0, treasury: 0, platformFloat: 0, platformFees: 0, platformFx: 0, agentFloat: 0, created: 0, destroyed: 0, createdByAuthority: {}, conservationGap: 0 });
  for (const r of supplyRows) {
    const s = supplyByCurrency.get(r.currency) ?? blank(r.currency);
    const bal = Number(r.bal);
    if (r.account_type === "wallet") {
      if (treasuryIds.has(r.account_id)) s.treasury += bal; else s.userLiabilities += bal;
    } else if (r.account_id === "platform_float") s.platformFloat += bal;
    else if (r.account_id === "platform_fees") s.platformFees += bal;
    else if (r.account_id === "platform_fx") s.platformFx += bal;
    supplyByCurrency.set(r.currency, s);
  }
  for (const r of agentFloat) {
    const s = supplyByCurrency.get(r.currency);
    if (s) s.agentFloat = Number(r.total);
  }
  for (const r of floatFlows) {
    const s = supplyByCurrency.get(r.currency) ?? blank(r.currency);
    s.created = Number(r.created); s.destroyed = Number(r.destroyed);
    supplyByCurrency.set(r.currency, s);
  }
  for (const r of createdByAuthority) {
    const s = supplyByCurrency.get(r.currency);
    if (s) s.createdByAuthority[r.authority] = Number(r.total);
  }
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  const supply = [...supplyByCurrency.values()].map((s) => {
    const gap = r4((s.userLiabilities + s.treasury + s.platformFees + s.platformFx) - (s.created - s.destroyed));
    if (Math.abs(gap) > 0.0001) anomalies.push(`I13 ${s.currency}: liabilities+treasury+fees+fx differ from created−destroyed by ${gap}`);
    return {
      ...s,
      userLiabilities: r4(s.userLiabilities), treasury: r4(s.treasury), platformFloat: r4(s.platformFloat),
      platformFees: r4(s.platformFees), platformFx: r4(s.platformFx), created: r4(s.created), destroyed: r4(s.destroyed),
      conservationGap: gap,
    };
  });

  const outboxStats = await getOutboxStats().catch(() => ({ pending: 0, processing: 0, dead: 0 }));
  if (outboxStats.dead > 0) anomalies.push(`outbox: ${outboxStats.dead} dead-lettered event(s)`);

  const [sagaRow] = await rows<{ failed: string; compensated: string }>(sql`
    SELECT COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
           COUNT(*) FILTER (WHERE status = 'compensated')::text AS compensated
    FROM sagas WHERE updated_at > now() - interval '24 hours'`);
  const loanRows = await rows<{ currency: string; outstanding: string; n: string }>(sql`
    SELECT currency, (SUM(amount - amount_repaid))::text AS outstanding, COUNT(*)::text AS n
    FROM loans WHERE status IN ('approved', 'disbursed') GROUP BY currency`);

  const report: FinancialReport = {
    generatedAt: new Date().toISOString(),
    ok: anomalies.length === 0,
    anomalies,
    supply,
    cashIn: {
      executedTotal, open: Number(cashInOpen?.open ?? 0), overdueOpen: Number(cashInOpen?.overdue ?? 0),
      ledgerMismatch: cashInMismatch.map((m) => ({ requestId: m.id, reason: m.reason })),
    },
    checks: {
      depositsWithoutAuthority: Number(noAuthority?.n ?? 0),
      depositsNonProductionAuthority: Number(nonProd?.n ?? 0),
      tontineReserveOverdrawn: reserveOver.map((r) => ({ tontineId: r.id, reserve: Number(r.reserve), walletBalance: Number(r.bal) })),
      poolMismatch: poolMismatch.map((p) => ({ poolId: p.id, reason: p.reason })),
      idempotencyOrphans: Number(idemOrphans?.n ?? 0),
      unbalancedTransactions: unbalanced.map((u) => ({ transactionId: u.transaction_id, currency: u.currency, debit: Number(u.d), credit: Number(u.c) })),
      malformedEntries: Number(malformed?.n ?? 0),
      overdrawnWallets: overdrawn.map((o) => ({ walletId: o.wallet_id, currency: o.currency, balance: Number(o.bal) })),
      balanceDrift: drift.map((d) => ({ walletId: d.wallet_id, stored: Number(d.stored), derived: Number(d.derived) })),
      stuckTransactions: stuckTx.map((t) => ({ id: t.id, status: t.status, ageMinutes: Math.round(Number(t.age)) })),
      stuckFloatTransfers: stuckFloat.map((f) => ({ id: f.id, fromAgentId: f.from_agent_id, toAgentId: f.to_agent_id, amount: Number(f.amount), ageMinutes: Math.round(Number(f.age)) })),
      completedWithoutEntries: Number(noEntries?.n ?? 0),
      fxArbitrage,
      stuckIdempotency: Number(stuckIdem?.n ?? 0),
      outbox: { pending: outboxStats.pending, processing: outboxStats.processing, dead: outboxStats.dead },
      sagas: { failed24h: Number(sagaRow?.failed ?? 0), compensated24h: Number(sagaRow?.compensated ?? 0) },
      loans: loanRows.map((l) => ({ currency: l.currency, outstandingPrincipal: Number(l.outstanding), activeLoans: Number(l.n) })),
    },
  };
  return report;
}

// Scheduled entry point: anomalies become incidents and an audit record.
export async function scheduledFinancialReconciliation(): Promise<FinancialReport> {
  const report = await runFinancialReconciliation();
  if (!report.ok) {
    for (const a of report.anomalies) logIncident({ type: "financial_reconciliation", action: "anomaly", result: a });
    console.warn(`[Reconciliation] ${report.anomalies.length} anomaly(ies): ${report.anomalies.join(" | ")}`);
  }
  await audit({ action: "reconciliation.report", entity: "system", entityId: "financial", metadata: { ok: report.ok, anomalies: report.anomalies, supply: report.supply } });
  return report;
}
