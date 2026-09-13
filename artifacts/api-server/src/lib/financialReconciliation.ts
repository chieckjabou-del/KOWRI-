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
  supply: Array<{ currency: string; userLiabilities: number; treasury: number; platformFloat: number; platformFees: number; platformFx: number; agentFloat: number }>;
  checks: {
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

  const supplyRows = await rows<{ currency: string; account_id: string; account_type: string; bal: string }>(sql`
    SELECT currency, account_id, account_type, (SUM(credit_amount) - SUM(debit_amount))::text AS bal
    FROM ledger_entries GROUP BY currency, account_id, account_type`);
  const treasuryWallets = await rows<{ id: string }>(sql`SELECT id FROM wallets WHERE user_id = ${TREASURY_USER_ID}`);
  const treasuryIds = new Set(treasuryWallets.map((w) => w.id));
  const agentFloat = await rows<{ currency: string; total: string }>(sql`
    SELECT 'XOF' AS currency, COALESCE(SUM(float_balance), 0)::text AS total FROM agent_wallets`);
  const supplyByCurrency = new Map<string, FinancialReport["supply"][number]>();
  for (const r of supplyRows) {
    const s = supplyByCurrency.get(r.currency) ?? { currency: r.currency, userLiabilities: 0, treasury: 0, platformFloat: 0, platformFees: 0, platformFx: 0, agentFloat: 0 };
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
  const supply = [...supplyByCurrency.values()].map((s) => ({
    ...s,
    userLiabilities: Math.round(s.userLiabilities * 10000) / 10000,
    treasury: Math.round(s.treasury * 10000) / 10000,
    platformFloat: Math.round(s.platformFloat * 10000) / 10000,
    platformFees: Math.round(s.platformFees * 10000) / 10000,
    platformFx: Math.round(s.platformFx * 10000) / 10000,
  }));

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
    checks: {
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
