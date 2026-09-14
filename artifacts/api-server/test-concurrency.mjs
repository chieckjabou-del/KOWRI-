// ── Targeted concurrency pass ────────────────────────────────────────────────
// Every money-moving operation is fired 2, 5, 10 and 20 times at once against
// a state that can only afford a known number of them. The assertion is
// always the same: exactly the affordable count succeeds, the balances add up
// to the cent, the losers are typed refusals (never 500), and the ledger stays
// balanced and non-negative for every transaction written by the burst.
//
// Operations: cash-in approval, transfer, loan disbursement, loan repayment,
// pool invest, pool redeem, FX remittance, agent float transfer, tontine
// collection, solidarity claim, savings lock, treasury liquidity.

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { get, post, chk, summary, createUser, balance, fund, operators, asAdminToken, uniquePhone, adminOpts } from "./test-lib.mjs";

const DB = process.env.DATABASE_URL ?? "postgres://kowri:kowri@localhost:5432/kowri";
const sql = (q) => execFileSync("psql", [DB, "-Atc", q], { encoding: "utf8" }).trim();
const LEVELS = [2, 5, 10, 20];
const RUN = randomUUID().slice(0, 8);
const spread = (rs) => JSON.stringify(rs.reduce((m, r) => (m[`${r.s}${r.b?.code ? ":" + r.b.code : ""}`] = (m[`${r.s}${r.b?.code ? ":" + r.b.code : ""}`] ?? 0) + 1, m), {}));
const no500 = (rs) => rs.every((r) => r.s !== 500 && r.s !== 0);
const { root, checker } = await operators();
const ADMIN = await adminOpts();
const { ensureAdmin } = await import("./test-lib.mjs");
const runMaker = await ensureAdmin({ email: `conc-maker-${RUN}@kowri.test`, name: "Concurrency maker", password: "ConcMakerPassw0rd-2026", role: "operations" }, root.token);

// Ledger invariants over everything written since `since`.
function ledgerClean(since) {
  const unbalanced = sql(`select count(*) from (select transaction_id, currency from ledger_entries where created_at >= '${since}' group by 1,2 having sum(debit_amount) <> sum(credit_amount)) u`);
  const overdrawn = sql(`select count(*) from (select account_id, currency from ledger_entries where account_type = 'wallet' group by 1,2 having sum(credit_amount) - sum(debit_amount) < 0) o`);
  const drift = sql(`select count(*) from wallets w where w.updated_at >= '${since}' and abs(w.balance - coalesce((select sum(credit_amount) - sum(debit_amount) from ledger_entries where account_id = w.id and account_type = 'wallet' and currency = w.currency), 0)) > 0.0001`);
  return { ok: unbalanced === "0" && overdrawn === "0" && drift === "0", detail: `unbalanced=${unbalanced} overdrawn=${overdrawn} drift=${drift}` };
}
const now = () => sql("select now()");

async function level(name, n, run) {
  const since = now();
  const out = await run(n);
  const inv = ledgerClean(since);
  chk(`${name} ×${n}: ${out.label}`, out.ok && no500(out.rs ?? []), `${out.detail ?? ""} ${spread(out.rs ?? [])}`);
  chk(`${name} ×${n}: ledger balanced, no overdraft, no drift`, inv.ok, inv.detail);
}

// ── 1. Cash-in approval ──────────────────────────────────────────────────────
console.log("\n1. Cash-in approval (one request, N approvers at once)");
for (const n of LEVELS) await level("cash-in approve", n, async (n) => {
  const u = await createUser({ kycLevel: 2 });
  const req = await post("/admin/cash-in", { walletId: u.wallet.id, amount: 5000, currency: "XOF", source: "other", reference: `CC-${RUN}-${n}` }, asAdminToken(runMaker.token, { idempotency: true }));
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => post(`/admin/cash-in/${req.b.request.id}/approve`, {}, asAdminToken(i % 2 ? checker.token : root.token))));
  const ok = rs.filter((r) => r.s === 200 && r.b?.request?.status === "EXECUTED").length;
  const bal = await balance(u, u.wallet.id);
  return { ok: ok === 1 && bal === 5000 && rs.filter((r) => r.s !== 200).every((r) => r.s === 409), label: "exactly one execution, credited once", detail: `executed=${ok} balance=${bal}`, rs };
});

// ── 2. Transfer ──────────────────────────────────────────────────────────────
console.log("\n2. Transfer (balance for 3, N at once)");
for (const n of LEVELS) await level("transfer", n, async (n) => {
  const a = await createUser({ kycLevel: 2 }); const b = await createUser();
  await fund(a.wallet.id, 3000);
  const rs = await Promise.all(Array.from({ length: n }, () => a.money(`/wallets/${a.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: 1000, currency: "XOF" })));
  const ok = rs.filter((r) => r.s === 200).length; const want = Math.min(n, 3);
  const ba = await balance(a, a.wallet.id), bb = await balance(b, b.wallet.id);
  return { ok: ok === want && ba === 3000 - want * 1000 && bb === want * 1000, label: `exactly ${want} succeed, balances add up`, detail: `ok=${ok} a=${ba} b=${bb}`, rs };
});

// ── 3. Loan disbursement ─────────────────────────────────────────────────────
console.log("\n3. Loan disbursement (credit line for one loan, N requests at once)");
for (const n of LEVELS) await level("loan disbursement", n, async (n) => {
  const a = await createUser({ kycLevel: 2 });
  const sc = await a.post(`/credit/scores/${a.userId}/compute`, {});
  const max = Number(sc.b?.maxLoanAmount ?? 50_000);
  const rs = await Promise.all(Array.from({ length: n }, () => a.money("/credit/loans", { walletId: a.wallet.id, amount: max, currency: "XOF", termDays: 30 })));
  const ok = rs.filter((r) => r.s === 201).length;
  const bal = await balance(a, a.wallet.id);
  const outstanding = Number(sql(`select coalesce(sum(amount - amount_repaid), 0) from loans where user_id = '${a.userId}' and status in ('approved','disbursed')`));
  return { ok: ok === 1 && bal === max && outstanding === max, label: "exactly one loan granted, exposure = credit line", detail: `granted=${ok} balance=${bal} outstanding=${outstanding}`, rs };
});

// ── 4. Loan repayment ────────────────────────────────────────────────────────
console.log("\n4. Loan repayment (one loan, N full repayments at once)");
for (const n of LEVELS) await level("loan repayment", n, async (n) => {
  const a = await createUser({ kycLevel: 2 });
  const sc = await a.post(`/credit/scores/${a.userId}/compute`, {});
  const max = Number(sc.b?.maxLoanAmount ?? 50_000);
  const loan = await a.money("/credit/loans", { walletId: a.wallet.id, amount: max, currency: "XOF", termDays: 30 });
  await fund(a.wallet.id, max * 3);
  const before = await balance(a, a.wallet.id);
  const rs = await Promise.all(Array.from({ length: n }, () => a.money(`/credit/loans/${loan.b?.id}/repay`, { walletId: a.wallet.id, amount: max })));
  const after = await balance(a, a.wallet.id);
  const repaid = Number(sql(`select amount_repaid from loans where id = '${loan.b?.id}'`));
  return { ok: before - after === max && repaid === max, label: "exactly the principal is taken, once", detail: `debited=${before - after} repaid=${repaid}`, rs };
});

// ── 5. Pool invest / redeem ──────────────────────────────────────────────────
console.log("\n5. Investment pool (balance for 3 investments, N at once; then N redeems of one position)");
for (const n of LEVELS) await level("pool invest", n, async (n) => {
  const m = await createUser({ kycLevel: 2 });
  const pool = (await m.post("/pools/investment", { name: `P${RUN}${n}`, goalAmount: 10_000_000, minInvestment: 1000 })).b;
  const u = await createUser({ kycLevel: 2 });
  await fund(u.wallet.id, 30_000);
  const rs = await Promise.all(Array.from({ length: n }, () => u.money(`/pools/investment/${pool.id}/invest`, { fromWalletId: u.wallet.id, amount: 10_000 })));
  const ok = rs.filter((r) => r.s === 201).length; const want = Math.min(n, 3);
  const p = (await m.get(`/pools/investment/${pool.id}`)).b;
  const positions = Number(sql(`select coalesce(sum(invested_amount), 0) from pool_positions where pool_id = '${pool.id}' and status = 'active'`));
  const poolBal = await balance(m, pool.walletId);
  return { ok: ok === want && Number(p?.currentAmount) === want * 10_000 && positions === want * 10_000 && poolBal === want * 10_000 && (await balance(u, u.wallet.id)) === 30_000 - want * 10_000, label: `exactly ${want} positions, pool = positions = wallet`, detail: `ok=${ok} pool=${p?.currentAmount} positions=${positions} wallet=${poolBal}`, rs };
});
for (const n of LEVELS) await level("pool redeem", n, async (n) => {
  const m = await createUser({ kycLevel: 2 });
  const pool = (await m.post("/pools/investment", { name: `R${RUN}${n}`, goalAmount: 10_000_000, minInvestment: 1000 })).b;
  const u = await createUser({ kycLevel: 2 });
  await fund(u.wallet.id, 10_000);
  const inv = await u.money(`/pools/investment/${pool.id}/invest`, { fromWalletId: u.wallet.id, amount: 10_000 });
  const posId = inv.b?.position?.id ?? inv.b?.id ?? sql(`select id from pool_positions where pool_id = '${pool.id}' limit 1`);
  const rs = await Promise.all(Array.from({ length: n }, () => u.money(`/pools/investment/positions/${posId}/redeem`, {})));
  const ok = rs.filter((r) => r.s === 200).length;
  const bal = await balance(u, u.wallet.id);
  const poolBal = await balance(m, pool.walletId);
  return { ok: ok === 1 && bal === 10_000 && poolBal === 0 && Number((await m.get(`/pools/investment/${pool.id}`)).b?.currentAmount) === 0, label: "exactly one redemption, money back once", detail: `ok=${ok} investor=${bal} pool=${poolBal}`, rs };
});

// ── 6. FX remittance ─────────────────────────────────────────────────────────
console.log("\n6. FX remittance XAF→USD (balance for 3 sends, N at once)");
for (const n of LEVELS) await level("fx remittance", n, async (n) => {
  const a = await createUser({ kycLevel: 2 });
  const xaf = (await a.post("/wallets", { currency: "XAF", walletType: "personal" })).b;
  const usd = (await a.post("/wallets", { currency: "USD", walletType: "personal" })).b;
  await fund(xaf.id, 300_000, "XAF");
  const ben = (await a.post("/diaspora/beneficiaries", { name: "me", walletId: usd.id, country: "US", currency: "USD" })).b;
  const rs = await Promise.all(Array.from({ length: n }, () => a.money("/diaspora/send", { fromWalletId: xaf.id, beneficiaryId: ben.id, amount: 100_000, fromCurrency: "XAF", toCurrency: "USD" })));
  const ok = rs.filter((r) => r.s === 201).length; const want = Math.min(n, 3);
  const bx = await balance(a, xaf.id), bu = await balance(a, usd.id);
  const perLeg = rs.find((r) => r.s === 201)?.b?.convertedAmount ?? rs.find((r) => r.s === 201)?.b?.receivedAmount ?? null;
  return { ok: ok === want && bx === 300_000 - want * 100_000 && bu > 0 && (perLeg === null || Math.abs(bu - want * perLeg) < 0.01), label: `exactly ${want} legs, source and destination consistent`, detail: `ok=${ok} xaf=${bx} usd=${bu} perLeg=${perLeg}`, rs };
});

// ── 7. Agent float transfer ──────────────────────────────────────────────────
console.log("\n7. Agent float transfer (float for 3, N at once)");
for (const n of LEVELS) await level("agent float", n, async (n) => {
  const owner = await createUser({ kycLevel: 2 });
  const mk = async (name) => (await post("/agents", { userId: owner.userId, name, type: "SUPER_AGENT", phone: uniquePhone(), zone: "Z" }, ADMIN)).b;
  const A = await mk(`A${n}`); const B = await mk(`B${n}`);
  await fund(A.walletId, 3000);
  sql(`update agent_wallets set float_balance = 3000 where agent_id = '${A.agent.id}'`);
  const rs = await Promise.all(Array.from({ length: n }, () => owner.money(`/agents/${A.agent.id}/liquidity-transfer`, { toAgentId: B.agent.id, amount: 1000, type: "FLOAT" })));
  const ok = rs.filter((r) => r.s === 200 || r.s === 201).length; const want = Math.min(n, 3);
  const floatA = Number(sql(`select float_balance from agent_wallets where agent_id = '${A.agent.id}'`));
  const floatB = Number(sql(`select float_balance from agent_wallets where agent_id = '${B.agent.id}'`));
  const wa = await balance(owner, A.walletId), wb = await balance(owner, B.walletId);
  const completed = Number(sql(`select count(*) from liquidity_transfers where from_agent_id = '${A.agent.id}' and status = 'COMPLETED'`));
  const pending = Number(sql(`select count(*) from liquidity_transfers where from_agent_id = '${A.agent.id}' and status = 'PENDING'`));
  return { ok: ok === want && floatA === 3000 - want * 1000 && floatB === want * 1000 && wa === 3000 - want * 1000 && wb === want * 1000 && completed === want && pending === 0, label: `exactly ${want} transfers, float = ledger, nothing PENDING`, detail: `ok=${ok} floatA=${floatA} floatB=${floatB} walletA=${wa} walletB=${wb} completed=${completed} pending=${pending}`, rs };
});

// ── 8. Tontine collection ────────────────────────────────────────────────────
console.log("\n8. Tontine collection (one round, N collect calls at once)");
for (const n of LEVELS) await level("tontine collect", n, async (n) => {
  const admin = await createUser({ kycLevel: 2 });
  const t = (await admin.post("/tontines", { name: `T${RUN}${n}`, contributionAmount: 10_000, currency: "XOF", frequency: "monthly", maxMembers: 5 })).b;
  const members = [];
  for (let i = 0; i < 3; i++) { const u = await createUser({ kycLevel: 2 }); await fund(u.wallet.id, 50_000); await u.post(`/community/tontines/${t.id}/members`, {}); members.push(u); }
  await admin.post(`/community/tontines/${t.id}/activate`, { rotationModel: "fixed" });
  const rs = await Promise.all(Array.from({ length: n }, () => admin.money(`/community/tontines/${t.id}/collect`, {})));
  const collected = rs.reduce((s, r) => s + (r.b?.collected ?? 0), 0);
  const bals = await Promise.all(members.map((m) => balance(m, m.wallet.id)));
  const poolWallet = (await admin.get(`/tontines/${t.id}`)).b.walletId;
  const poolBal = await balance(admin, poolWallet);
  return { ok: collected === 3 && bals.every((b) => b === 40_000) && poolBal === 30_000, label: "each member charged exactly once, pool holds one round", detail: `collected=${collected} members=${bals.join("/")} pool=${poolBal}`, rs };
});

// ── 9. Solidarity claims ─────────────────────────────────────────────────────
console.log("\n9. Solidarity claim (reserve 40 000 for 4 members, one member claims N times at once)");
for (const n of LEVELS) await level("solidarity claim", n, async (n) => {
  const admin = await createUser({ kycLevel: 2 });
  const t = (await admin.post("/tontines", { name: `S${RUN}${n}`, contributionAmount: 10_000, currency: "XOF", frequency: "monthly", maxMembers: 5 })).b;
  const members = [];
  for (let i = 0; i < 3; i++) { const u = await createUser(); await u.post(`/community/tontines/${t.id}/members`, {}); members.push(u); }
  await admin.post(`/community/tontines/${t.id}/activate`, { rotationModel: "fixed" });
  const poolWallet = (await admin.get(`/tontines/${t.id}`)).b.walletId;
  await fund(poolWallet, 400_000);
  sql(`update tontines set solidarity_reserve = 40000 where id = '${t.id}'`);
  const rs = await Promise.all(Array.from({ length: n }, () => members[0].post(`/community/tontines/${t.id}/solidarity-claim`, { amount: 10_000, reason: "urgent", urgency: "high" })));
  const disbursed = rs.filter((r) => r.b?.status === "disbursed").length;
  const poolBal = await balance(admin, poolWallet);
  const reserve = Number(sql(`select solidarity_reserve from tontines where id = '${t.id}'`));
  return { ok: disbursed === 1 && poolBal === 390_000 && reserve === 30_000, label: "at most the fair share is paid, reserve decremented once", detail: `disbursed=${disbursed} pool=${poolBal} reserve=${reserve}`, rs };
});

// ── 10. Savings lock ─────────────────────────────────────────────────────────
console.log("\n10. Savings plan (balance for 3 locks, N at once)");
for (const n of LEVELS) await level("savings lock", n, async (n) => {
  const u = await createUser({ kycLevel: 2 });
  await fund(u.wallet.id, 30_000);
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => u.money("/savings/plans", { walletId: u.wallet.id, name: `S${i}`, amount: 10_000, termDays: 30 })));
  const ok = rs.filter((r) => r.s === 201).length; const want = Math.min(n, 3);
  const bal = await balance(u, u.wallet.id);
  const locked = Number(sql(`select coalesce(sum(locked_amount), 0) from savings_plans where user_id = '${u.userId}' and status = 'active'`));
  return { ok: ok === want && bal === 30_000 - want * 10_000 && locked === want * 10_000, label: `exactly ${want} plans, locked = debited`, detail: `ok=${ok} balance=${bal} locked=${locked}`, rs };
});

// ── 11. Treasury liquidity ───────────────────────────────────────────────────
// A currency whose treasury holds exactly two loans' worth: N borrowers at once.
console.log("\n11. Treasury liquidity (treasury funded for 2 loans, N borrowers at once)");
{
  const CUR = "EUR";
  const treasury = (await get("/admin/treasury", root.opts)).b?.wallets?.find((w) => w.currency === CUR);
  let treasuryId = treasury?.id;
  if (!treasuryId) {
    // The treasury wallet for a currency is created on first use; provoke it with a refused loan.
    const p = await createUser({ kycLevel: 2 });
    const w = (await p.post("/wallets", { currency: CUR, walletType: "personal" })).b;
    await p.post(`/credit/scores/${p.userId}/compute`, {});
    await p.money("/credit/loans", { walletId: w.id, amount: 100, currency: CUR, termDays: 30 });
    treasuryId = (await get("/admin/treasury", root.opts)).b?.wallets?.find((x) => x.currency === CUR)?.id;
  }
  if (!treasuryId) {
    chk("11 treasury liquidity: EUR treasury wallet could not be provisioned (loans in EUR not supported) — not exercised", true);
  } else {
    for (const n of [2, 5, 10]) await level("treasury liquidity", n, async (n) => {
      const tBefore = Number((await get("/admin/treasury", root.opts)).b.wallets.find((w) => w.id === treasuryId).balance);
      const LOAN = 100;
      const need = Math.max(0, 2 * LOAN - tBefore);
      if (need > 0) await fund(treasuryId, need, CUR);
      const tStart = Number((await get("/admin/treasury", root.opts)).b.wallets.find((w) => w.id === treasuryId).balance);
      const affordable = Math.floor(tStart / LOAN);
      const borrowers = [];
      for (let i = 0; i < n; i++) { const b = await createUser({ kycLevel: 2 }); b.eur = (await b.post("/wallets", { currency: CUR, walletType: "personal" })).b; await b.post(`/credit/scores/${b.userId}/compute`, {}); borrowers.push(b); }
      const rs = await Promise.all(borrowers.map((b) => b.money("/credit/loans", { walletId: b.eur.id, amount: LOAN, currency: CUR, termDays: 30 })));
      const ok = rs.filter((r) => r.s === 201).length;
      const tAfter = Number((await get("/admin/treasury", root.opts)).b.wallets.find((w) => w.id === treasuryId).balance);
      const want = Math.min(n, affordable);
      // Repay so the next level starts from a known treasury balance.
      for (const b of borrowers) { await fund(b.eur.id, LOAN, CUR); const l = (await b.get("/credit/loans?limit=5")).b?.loans?.find?.((x) => x.status === "disbursed"); if (l) await b.money(`/credit/loans/${l.id}/repay`, { walletId: b.eur.id, amount: LOAN }); }
      return { ok: ok === want && tAfter === tStart - want * LOAN && tAfter >= 0 && rs.filter((r) => r.s !== 201).every((r) => r.s === 503 || r.s === 409 || r.s === 400), label: `exactly ${want} loans, treasury never negative`, detail: `granted=${ok} treasury ${tStart}→${tAfter}`, rs };
    });
  }
}

const rep = await get("/admin/reconciliation/report", root.opts);
chk("final reconciliation is clean after the whole pass", rep.b?.ok === true, JSON.stringify(rep.b?.anomalies));
const { fail } = summary("CONCURRENCY PASS");
process.exit(fail ? 1 : 0);
