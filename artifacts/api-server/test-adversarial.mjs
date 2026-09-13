// ── Adversarial suite ─────────────────────────────────────────────────────────
// Tries to break the money model with real HTTP traffic against a running API
// and checks the ledger's invariants directly in PostgreSQL afterwards.
// Every scenario here reproduced a real loss, creation or leak of money before
// the corresponding fix; the suite fails if any of them comes back.
//
// Run:  node test-adversarial.mjs   (API_BASE, DATABASE_URL, ADMIN_API_KEY)
// Requires psql on PATH for the database-level invariants.

import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  get, post, patch, put, raw, createUser, fund, balance, adminOpts, idem, login, chk, summary, uniquePhone,
} from "./test-lib.mjs";

const DB = process.env.DATABASE_URL ?? "postgres://kowri:kowri@localhost:5432/kowri";
function sql(query) {
  return execFileSync("psql", [DB, "-Atc", query], { encoding: "utf8" }).trim();
}
function sqlRows(query) { const out = sql(query); return out ? out.split("\n") : []; }
const codes = (rs) => rs.map((r) => r.s).sort((a, b) => a - b).join(",");
const spread = (rs) => rs.reduce((m, r) => (m[r.s] = (m[r.s] ?? 0) + 1, m), {});
const ADMIN = await adminOpts();

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── INV-1  Double spend: one wallet, thirty simultaneous full-balance transfers ──");
{
  const a = await createUser({ kycLevel: 2 }); const b = await createUser();
  await fund(a.wallet.id, 10_000);
  const rs = await Promise.all(Array.from({ length: 30 }, () =>
    a.money(`/wallets/${a.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: 10_000, currency: "XOF" })));
  const ok = rs.filter((r) => r.s === 200).length;
  chk("INV-1a exactly one transfer succeeds", ok === 1, `succeeded=${ok} ${JSON.stringify(spread(rs))}`);
  chk("INV-1b sender ends at 0, never negative", (await balance(a, a.wallet.id)) === 0);
  chk("INV-1c receiver holds exactly 10 000", (await balance(b, b.wallet.id)) === 10_000);
}

console.log("\n── INV-2  KYC ceiling under concurrency (level 0 = 100 000 XOF/month) ──");
{
  const a = await createUser(); const b = await createUser();
  await fund(a.wallet.id, 1_000_000);
  const rs = await Promise.all(Array.from({ length: 8 }, () =>
    a.money(`/wallets/${a.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: 40_000, currency: "XOF" })));
  const moved = rs.filter((r) => r.s === 200).length * 40_000;
  chk("INV-2a parallel transfers cannot exceed the monthly ceiling", moved <= 100_000, `moved=${moved} ${JSON.stringify(spread(rs))}`);
  chk("INV-2b refusals are typed KYC_LIMIT", rs.filter((r) => r.s === 400).every((r) => r.b?.code === "KYC_LIMIT"));
}

console.log("\n── INV-3  Credit: exposure ceiling and repayment atomicity ──");
{
  const a = await createUser({ kycLevel: 2 });
  const sc = await a.post(`/credit/scores/${a.userId}/compute`, {});
  const max = Number(sc.b?.maxLoanAmount ?? 50_000);
  const loans = await Promise.all(Array.from({ length: 4 }, () =>
    a.money("/credit/loans", { walletId: a.wallet.id, amount: max, currency: "XOF", termDays: 30 })));
  const granted = loans.filter((l) => l.s === 201).length;
  chk("INV-3a four parallel loans at the credit line → exactly one granted", granted === 1, codes(loans));
  chk("INV-3b refusals are 409 CREDIT_LINE_EXCEEDED", loans.filter((l) => l.s !== 201).every((l) => l.s === 409 && l.b?.code === "CREDIT_LINE_EXCEEDED"));
  chk("INV-3c borrower received the principal once", (await balance(a, a.wallet.id)) === max);
  const loanId = loans.find((l) => l.s === 201)?.b?.id;
  const loan0 = await a.get(`/credit/loans/${loanId}`);
  chk("INV-3d loan is recorded as disbursed atomically with the transfer", loan0.b?.status === "disbursed" && !!loan0.b?.disbursedAt);
  await fund(a.wallet.id, max * 5);
  const before = await balance(a, a.wallet.id);
  const reps = await Promise.all(Array.from({ length: 5 }, () =>
    a.money(`/credit/loans/${loanId}/repay`, { walletId: a.wallet.id, amount: max })));
  const after = await balance(a, a.wallet.id);
  const loan = await a.get(`/credit/loans/${loanId}`);
  chk("INV-3e five parallel full repayments → exactly one accepted", reps.filter((r) => r.s === 201).length === 1, codes(reps));
  chk("INV-3f the borrower paid exactly once", before - after === max, `paid=${before - after}`);
  chk("INV-3g loan shows amountRepaid = principal and status repaid", Number(loan.b?.amountRepaid) === max && loan.b?.status === "repaid");
  const rows = sql(`select count(*) from loan_repayments where loan_id = '${loanId}'`);
  chk("INV-3h exactly one repayment record", rows === "1", `rows=${rows}`);
  const over = await a.money(`/credit/loans/${loanId}/repay`, { walletId: a.wallet.id, amount: 1 });
  chk("INV-3i repaying a repaid loan is refused", over.s === 400 || over.s === 409, `status=${over.s}`);
}

console.log("\n── INV-4  Idempotency: same key must never yield a second financial effect ──");
{
  const a = await createUser({ kycLevel: 2 }); const b = await createUser(); const c = await createUser();
  await fund(a.wallet.id, 100_000);
  const key = idem();
  const r1 = await a.money(`/wallets/${a.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: 1000, currency: "XOF" }, { idempotency: key });
  const r2 = await a.money(`/wallets/${a.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: 1000, currency: "XOF" }, { idempotency: key });
  const r3 = await a.money(`/wallets/${a.wallet.id}/transfer`, { toWalletId: c.wallet.id, amount: 9000, currency: "XOF" }, { idempotency: key });
  chk("INV-4a first call executes", r1.s === 200);
  chk("INV-4b identical retry is replayed, not re-executed", r2.s === 200 && r2.h.get("x-idempotent-replayed") === "true" && r2.b?.id === r1.b?.id);
  chk("INV-4c same key with a different body is refused (422 IDEMPOTENCY_PAYLOAD_MISMATCH)", r3.s === 422 && r3.b?.code === "IDEMPOTENCY_PAYLOAD_MISMATCH", `status=${r3.s}`);
  chk("INV-4d only one transfer left the wallet", (await balance(a, a.wallet.id)) === 99_000 && (await balance(c, c.wallet.id)) === 0);
  const burst = await Promise.all(Array.from({ length: 20 }, () =>
    a.money(`/wallets/${a.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: 500, currency: "XOF" }, { idempotency: "burst-" + key })));
  const executed = burst.filter((r) => r.s === 200 && r.h.get("x-idempotent-replayed") !== "true").length;
  chk("INV-4e twenty simultaneous requests with one key → one execution", executed === 1 && (await balance(a, a.wallet.id)) === 98_500, `executed=${executed} ${JSON.stringify(spread(burst))}`);
  // Another user cannot replay A's key to obtain A's cached response.
  const d = await createUser({ kycLevel: 2 }); await fund(d.wallet.id, 5000);
  const r4 = await d.money(`/wallets/${d.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: 1000, currency: "XOF" }, { idempotency: key });
  chk("INV-4f keys are scoped per user (another user's identical key executes their own request)", r4.s === 200 && r4.b?.fromWalletId === d.wallet.id);
}

console.log("\n── INV-5  Transactions are private: no listing or lookup across users ──");
{
  const a = await createUser(); const b = await createUser();
  await fund(b.wallet.id, 5000);
  const list = await a.get("/transactions?limit=50");
  chk("INV-5a a fresh user sees an empty transaction list", list.s === 200 && list.b?.pagination?.total === 0, `total=${list.b?.pagination?.total}`);
  const bTx = (await b.get("/transactions")).b?.transactions?.[0];
  const peek = await a.get(`/transactions/${bTx.id}`);
  chk("INV-5b another user's transaction id answers 404", peek.s === 404, `status=${peek.s}`);
  const viaWallet = await a.get(`/transactions?walletId=${b.wallet.id}`);
  chk("INV-5c filtering by someone else's wallet answers 404", viaWallet.s === 404);
  const adminView = await get(`/transactions/${bTx.id}`, ADMIN);
  chk("INV-5d operators still see it", adminView.s === 200);
}

console.log("\n── INV-6  FX: no round trip may return more than it started with ──");
{
  const a = await createUser({ kycLevel: 2 });
  const xaf = (await a.post("/wallets", { currency: "XAF", walletType: "personal" })).b;
  const usd = (await a.post("/wallets", { currency: "USD", walletType: "personal" })).b;
  await fund(xaf.id, 1_000_000, "XAF");
  const bUsd = (await a.post("/diaspora/beneficiaries", { name: "me", walletId: usd.id, country: "US", currency: "USD" })).b;
  const bXaf = (await a.post("/diaspora/beneficiaries", { name: "me2", walletId: xaf.id, country: "CM", currency: "XAF" })).b;
  const s1 = await a.money("/diaspora/send", { fromWalletId: xaf.id, beneficiaryId: bUsd.id, amount: 1_000_000, fromCurrency: "XAF", toCurrency: "USD" });
  const usdBal = await balance(a, usd.id);
  const s2 = await a.money("/diaspora/send", { fromWalletId: usd.id, beneficiaryId: bXaf.id, amount: usdBal, fromCurrency: "USD", toCurrency: "XAF" });
  const end = await balance(a, xaf.id);
  chk("INV-6a both legs execute", s1.s === 201 && s2.s === 201, `${s1.s}/${s2.s} ${s1.b?.message ?? ""} ${s2.b?.message ?? ""}`);
  chk("INV-6b XAF→USD→XAF ends at or below the starting amount", end <= 1_000_000, `end=${end}`);
  const bad = await put("/fx/rates", { base_currency: "XAF", target_currency: "USD", rate: 0.0017 }, ADMIN);
  chk("INV-6c publishing an inverse that multiplies above 1 is refused (409 FX_ARBITRAGE)", bad.s === 409 && bad.b?.code === "FX_ARBITRAGE", `status=${bad.s}`);
  const cons = await get("/fx/rates/consistency", ADMIN);
  chk("INV-6d published rates are consistent", cons.s === 200 && cons.b?.consistent === true, JSON.stringify(cons.b?.arbitrage ?? cons.b));
  const fxEntries = sql(`select count(*) from ledger_entries where transaction_id in (select id from transactions where reference in ('${s1.b?.txId ?? "x"}')) `);
  chk("INV-6e zero-fee remittance writes no empty fee entry", Number(sql(`select count(*) from ledger_entries where transaction_id = '${s1.b?.txId}' and debit_amount = 0 and credit_amount = 0`)) === 0, fxEntries);
}

console.log("\n── INV-7  Investment pool: concurrent investors, shares issued at one price ──");
{
  const m = await createUser({ kycLevel: 2 });
  const pool = (await m.post("/pools/investment", { name: "P", goalAmount: 1_000_000, minInvestment: 1000 })).b;
  const inv = await Promise.all(Array.from({ length: 5 }, async () => { const u = await createUser({ kycLevel: 2 }); await fund(u.wallet.id, 50_000); return u; }));
  const rs = await Promise.all(inv.map((u) => u.money(`/pools/investment/${pool.id}/invest`, { fromWalletId: u.wallet.id, amount: 10_000 })));
  const p = await m.get(`/pools/investment/${pool.id}`);
  chk("INV-7a all five investments accepted", rs.every((r) => r.s === 201), codes(rs));
  chk("INV-7b pool totals equal the sum of investments (no lost update)", Number(p.b?.currentAmount) === 50_000 && Number(p.b?.totalShares) === 50_000, `${p.b?.currentAmount}/${p.b?.totalShares}`);
  chk("INV-7c pool wallet holds exactly the invested money", (await balance(m, pool.walletId)) === 50_000);
  chk("INV-7d every position carries its ledger transaction", sql(`select count(*) from pool_positions where pool_id = '${pool.id}' and transaction_id is null`) === "0");
}

console.log("\n── INV-8  Tontine solidarity: a member cannot drain the group's money ──");
{
  const admin = await createUser({ kycLevel: 2 });
  const t = (await admin.post("/tontines", { name: "T", contributionAmount: 10_000, currency: "XOF", frequency: "monthly", maxMembers: 5 })).b;
  const members = [];
  for (let i = 0; i < 3; i++) { const u = await createUser(); await u.post(`/community/tontines/${t.id}/members`, {}); members.push(u); }
  await admin.post(`/community/tontines/${t.id}/activate`, { rotationModel: "fixed" });
  const poolWallet = (await admin.get(`/tontines/${t.id}`)).b.walletId;
  await fund(poolWallet, 400_000);
  sql(`update tontines set solidarity_reserve = 40000 where id = '${t.id}'`);
  const claimer = members[0];
  const rs = await Promise.all(Array.from({ length: 12 }, () =>
    claimer.post(`/community/tontines/${t.id}/solidarity-claim`, { amount: 10_000, reason: "urgent", urgency: "high" })));
  const disbursed = rs.filter((r) => r.b?.status === "disbursed").length;
  chk("INV-8a twelve parallel claims → at most the member's fair share (40 000 / 4) is paid", disbursed === 1, `disbursed=${disbursed}`);
  chk("INV-8b the others are queued for the admin, not paid", rs.filter((r) => r.b?.status === "pending_admin").length === 11, JSON.stringify(rs.map((r) => `${r.s}:${r.b?.status ?? r.b?.message ?? r.b?.code}`)));
  chk("INV-8c pool balance dropped by exactly one claim", (await balance(admin, poolWallet)) === 390_000);
  chk("INV-8d reserve decremented exactly once", sql(`select solidarity_reserve::numeric from tontines where id='${t.id}'`) === "30000.0000");
}

console.log("\n── INV-9  Sessions: a PIN change kills every other session ──");
{
  const a = await createUser();
  const second = await login(a.user.phone);
  const ch = await a.patch(`/users/${a.userId}/pin`, { oldPin: "1234", newPin: "9876" });
  chk("INV-9a PIN change succeeds and reports revoked sessions", ch.s === 200 && ch.b?.otherSessionsRevoked === 1, JSON.stringify(ch.b));
  chk("INV-9b the other session is dead", (await second.get("/users/me")).s === 401);
  chk("INV-9c the changing session survives", (await a.get("/users/me")).s === 200);
  const out = await a.post("/wallet/logout", {});
  chk("INV-9d logout revokes the token", out.s === 200 && (await a.get("/users/me")).s === 401);
}

console.log("\n── INV-10  Amounts: nothing below one storable unit, nothing above the column ──");
{
  const a = await createUser({ kycLevel: 2 }); const b = await createUser();
  await fund(a.wallet.id, 100_000);
  for (const amt of [0.00001, 0.00004, 1e17, -5, "abc", { x: 1 }]) {
    const r = await a.money(`/wallets/${a.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: amt, currency: "XOF" });
    chk(`INV-10 amount ${JSON.stringify(amt)} is refused`, r.s === 400, `status=${r.s}`);
  }
  const ok = await a.money(`/wallets/${a.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: 12.34567, currency: "XOF" });
  chk("INV-10 amounts are rounded to the stored scale before posting", ok.s === 200 && ok.b?.amount === 12.3457, `${ok.s} ${ok.b?.amount}`);
  chk("INV-10 sender and receiver agree to the unit", (await balance(a, a.wallet.id)) + (await balance(b, b.wallet.id)) === 100_000);
}

console.log("\n── INV-11  Float transfers interrupted by a crash are recovered, once ──");
{
  // Two agents, two funded linked wallets. Simulate a crash after step 1 (float
  // moved, ledger leg never posted, record PENDING) and one after step 2 (ledger
  // posted, record PENDING); the recovery must finish both with one effect each.
  const owner = await createUser({ kycLevel: 2 });
  const RUN = Date.now().toString(36);
  const mk = async (name) => (await post("/agents", { userId: owner.userId, name, type: "SUPER_AGENT", phone: uniquePhone(), zone: "Z" }, ADMIN)).b;
  const A = await mk("A"); const B = await mk("B");
  chk("INV-11a agents created", !!A?.agent?.id && !!B?.agent?.id);
  await fund(A.walletId, 50_000); await fund(B.walletId, 10_000);
  sql(`update agent_wallets set float_balance = 50000 where agent_id = '${A.agent.id}'`);
  sql(`update agent_wallets set float_balance = 10000 where agent_id = '${B.agent.id}'`);
  // Crash type 1: float moved, no ledger.
  sql(`insert into liquidity_transfers (id, from_agent_id, to_agent_id, amount, type, status, initiated_by, note, created_at)
       values ('lt-crash-1-${RUN}', '${A.agent.id}', '${B.agent.id}', 5000, 'FLOAT', 'PENDING', 'agent', 'Float transfer via liquidityEngine [ledger:float:crash-1-${RUN}]', now() - interval '10 minutes')`);
  sql(`update agent_wallets set float_balance = float_balance - 5000 where agent_id = '${A.agent.id}'`);
  sql(`update agent_wallets set float_balance = float_balance + 5000 where agent_id = '${B.agent.id}'`);
  // Crash type 2: ledger leg posted under its key, record left PENDING. The leg
  // is written straight into the ledger (balanced, funded) because a posted
  // transaction's key can no longer be edited.
  const legId = `adv-float-${RUN}`;
  execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-c", `begin;
    insert into transactions (id, from_wallet_id, to_wallet_id, amount, currency, type, status, reference, idempotency_key)
      values ('${legId}', '${A.walletId}', '${B.walletId}', 3000, 'XOF', 'transfer', 'completed', 'ADV-FLOAT-${RUN}', 'float:crash-2-${RUN}');
    insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type, wallet_id)
      values ('${legId}-d', '${legId}', '${A.walletId}', 'wallet', 3000, 0, 'XOF', 'transfer', '${A.walletId}'),
             ('${legId}-c', '${legId}', '${B.walletId}', 'wallet', 0, 3000, 'XOF', 'transfer', '${B.walletId}');
    update wallets set balance = balance - 3000, available_balance = available_balance - 3000 where id = '${A.walletId}';
    update wallets set balance = balance + 3000, available_balance = available_balance + 3000 where id = '${B.walletId}';
    commit;`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  chk("INV-11a' ledger leg for the second crash exists", sql(`select count(*) from transactions where idempotency_key = 'float:crash-2-${RUN}'`) === "1");
  sql(`insert into liquidity_transfers (id, from_agent_id, to_agent_id, amount, type, status, initiated_by, note, created_at)
       values ('lt-crash-2-${RUN}', '${A.agent.id}', '${B.agent.id}', 3000, 'FLOAT', 'PENDING', 'agent', 'Float transfer via liquidityEngine [ledger:float:crash-2-${RUN}]', now() - interval '10 minutes')`);
  const balBefore = await balance(owner, B.walletId);
  const rec = await post("/admin/reconciliation/recover-float", {}, ADMIN);
  chk("INV-11b recovery endpoint runs", rec.s === 200, JSON.stringify(rec.b));
  chk("INV-11c both PENDING transfers are closed", sql(`select count(*) from liquidity_transfers where id in ('lt-crash-1-${RUN}','lt-crash-2-${RUN}') and status = 'COMPLETED'`) === "2", sql(`select id||':'||status from liquidity_transfers where id in ('lt-crash-1-${RUN}','lt-crash-2-${RUN}')`));
  chk("INV-11d the missing ledger leg was posted exactly once (5 000), the existing one not duplicated", (await balance(owner, B.walletId)) - balBefore === 5000);
  const again = await post("/admin/reconciliation/recover-float", {}, ADMIN);
  chk("INV-11e running recovery again is a no-op", again.s === 200 && (await balance(owner, B.walletId)) - balBefore === 5000);
  chk("INV-11f ledger holds exactly one transaction per key", sql(`select count(*) from transactions where idempotency_key in ('float:crash-1-${RUN}','float:crash-2-${RUN}')`) === "2");
}

console.log("\n── INV-12  Database-level guarantees (bypassing the application) ──");
{
  const tx = sql(`select id from transactions where status = 'completed' order by created_at desc limit 1`);
  let err1 = "";
  try { execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-Atc", `update ledger_entries set credit_amount = credit_amount + 1 where transaction_id = '${tx}'`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { err1 = String(e.stderr); }
  chk("INV-12a a ledger entry cannot be edited, even with direct SQL", /append-only/.test(err1), err1.split("\n")[0]);
  let err2 = "";
  try { execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-Atc", `delete from ledger_entries where transaction_id = '${tx}'`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { err2 = String(e.stderr); }
  chk("INV-12b a ledger entry cannot be deleted", /append-only/.test(err2));
  let err3 = "";
  try { execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-Atc", `delete from transactions where id = '${tx}'`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { err3 = String(e.stderr); }
  chk("INV-12c a transaction cannot be deleted", /never deleted/.test(err3));
  let err4 = "";
  try { execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-Atc", `update transactions set amount = amount + 1 where id = '${tx}'`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { err4 = String(e.stderr); }
  chk("INV-12d a transaction's amount cannot be changed", /immutable/.test(err4));
  // A one-sided posting must be rejected at COMMIT.
  const w = sql(`select id from wallets where currency = 'XOF' limit 1`);
  let err5 = "";
  try {
    execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-c", `begin; insert into transactions (id, to_wallet_id, amount, currency, type, status, reference, metadata) values ('adv-unbalanced', '${w}', 100, 'XOF', 'deposit', 'completed', 'ADV-UNBAL-${Date.now()}', '{"authority":"demo_seed"}'); insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('adv-e1', 'adv-unbalanced', '${w}', 'wallet', 0, 100, 'XOF', 'deposit'); commit;`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err5 = String(e.stderr); }
  chk("INV-12e an unbalanced transaction is refused at COMMIT (LEDGER_UNBALANCED)", /LEDGER_UNBALANCED/.test(err5), err5.split("\n")[0]);
  chk("INV-12e' nothing of it persisted", sql(`select count(*) from transactions where id = 'adv-unbalanced'`) === "0");
  // A debit that would overdraw a wallet is refused at COMMIT even if balanced.
  const empty = (await createUser()).wallet.id;
  let err6 = "";
  try {
    execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-c", `begin; insert into transactions (id, from_wallet_id, amount, currency, type, status, reference) values ('adv-overdraw', '${empty}', 100, 'XOF', 'withdrawal', 'completed', 'ADV-OVER-${Date.now()}'); insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('adv-e2', 'adv-overdraw', '${empty}', 'wallet', 100, 0, 'XOF', 'withdrawal'), ('adv-e3', 'adv-overdraw', 'platform_float', 'platform', 0, 100, 'XOF', 'withdrawal'); commit;`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { err6 = String(e.stderr); }
  chk("INV-12f an overdraft is refused at COMMIT (LEDGER_OVERDRAWN)", /LEDGER_OVERDRAWN/.test(err6), err6.split("\n")[0]);
  let err7 = "";
  try { execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-Atc", `insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('adv-e4', '${tx}', 'platform_float', 'platform', -5, 0, 'XOF', 'x')`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { err7 = String(e.stderr); }
  chk("INV-12g negative amounts are refused by CHECK", /non_negative|violates check/.test(err7));
}

console.log("\n── INV-13  Operators: second factor ──");
{
  // Bootstrap an operator through the legacy key, enrol TOTP, and prove that a
  // login without the code is refused once enrolled.
  const email = `mfa-${Date.now()}@akwe.test`;
  const password = "Str0ngPassw0rd!mfa";
  const created = await post("/admin/auth/users", { email, name: "MFA Test", password, role: "operations" }, ADMIN);
  chk("INV-13a operator account created", created.s === 201, JSON.stringify(created.b));
  const first = await post("/admin/auth/login", { email, password });
  chk("INV-13b password-only login works before enrolment", first.s === 200 && first.b?.mfaVerified === false);
  const tokenHeaders = { headers: { "X-Admin-Token": first.b?.token } };
  const setup = await post("/admin/auth/mfa/setup", {}, tokenHeaders);
  chk("INV-13c enrolment returns a secret and an otpauth URI", setup.s === 200 && /^otpauth:\/\/totp\//.test(setup.b?.uri ?? ""));
  const totp = (secret, step = Math.floor(Date.now() / 30000)) => {
    const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, v = 0; const bytes = [];
    for (const ch of secret) { v = (v << 5) | B.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((v >>> (bits - 8)) & 255); bits -= 8; } }
    const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(step));
    const d = createHmac("sha1", Buffer.from(bytes)).update(c).digest(); const o = d[d.length - 1] & 15;
    return String((((d[o] & 127) << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) % 1e6).padStart(6, "0");
  };
  const badConfirm = await post("/admin/auth/mfa/confirm", { code: "000000" }, tokenHeaders);
  chk("INV-13d a wrong code does not enable MFA", badConfirm.s === 401);
  const confirm = await post("/admin/auth/mfa/confirm", { code: totp(setup.b.secret) }, tokenHeaders);
  chk("INV-13e the right code enables MFA", confirm.s === 200 && confirm.b?.mfaEnabled === true, JSON.stringify(confirm.b));
  const noCode = await post("/admin/auth/login", { email, password });
  chk("INV-13f login without the code is refused (401 MFA_REQUIRED)", noCode.s === 401 && noCode.b?.code === "MFA_REQUIRED");
  const wrong = await post("/admin/auth/login", { email, password, totpCode: "123456" });
  chk("INV-13g login with a wrong code is refused", wrong.s === 401);
  const good = await post("/admin/auth/login", { email, password, totpCode: totp(setup.b.secret) });
  chk("INV-13h login with the code opens a verified session", good.s === 200 && good.b?.mfaVerified === true);
  const intro = await get("/admin/auth/introspect", { headers: { "X-Admin-Token": good.b?.token } });
  chk("INV-13i introspection reports the verified factor", intro.s === 200 && intro.b?.mfaVerified === true && intro.b?.mfaEnrolled === true);
}

console.log("\n── INV-14  Reconciliation: the ledger is consistent after every attack above ──");
{
  const rep = await get("/admin/reconciliation/report", ADMIN);
  chk("INV-14a report endpoint answers", rep.s === 200, `status=${rep.s}`);
  const c = rep.b?.checks ?? {};
  chk("INV-14b no unbalanced transaction", (c.unbalancedTransactions ?? []).length === 0);
  chk("INV-14c no malformed ledger entry", c.malformedEntries === 0);
  chk("INV-14d no overdrawn wallet", (c.overdrawnWallets ?? []).length === 0, JSON.stringify(c.overdrawnWallets));
  chk("INV-14e no stored/derived drift", (c.balanceDrift ?? []).length === 0, JSON.stringify(c.balanceDrift));
  chk("INV-14f no completed transaction without entries", c.completedWithoutEntries === 0);
  chk("INV-14g no stuck float transfer", (c.stuckFloatTransfers ?? []).length === 0);
  chk("INV-14h no FX arbitrage pair", (c.fxArbitrage ?? []).length === 0);
  chk("INV-14i money supply is reported per currency", Array.isArray(rep.b?.supply) && rep.b.supply.some((s) => s.currency === "XOF"));
  chk("INV-14j report is clean", rep.b?.ok === true, (rep.b?.anomalies ?? []).join(" | "));
  const xof = (rep.b?.supply ?? []).find((s) => s.currency === "XOF");
  chk("INV-14k per currency: user liabilities + treasury + fees + fx = -(platform float) (double-entry identity)",
    !!xof && Math.abs(xof.userLiabilities + xof.treasury + xof.platformFees + xof.platformFx + xof.platformFloat) < 0.01, JSON.stringify(xof));
  const sqlUnbalanced = sql(`select count(*) from (select transaction_id, currency from ledger_entries group by 1,2 having sum(debit_amount) <> sum(credit_amount)) x`);
  chk("INV-14l SQL: every transaction balances per currency", sqlUnbalanced === "0", sqlUnbalanced);
}

const { fail } = summary("ADVERSARIAL SUITE");
process.exit(fail ? 1 : 0);
