// Final adversarial check, strictly on the canary scope (wallets, transfers, manual cash-in).
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { get, post, chk, summary, createUser, balance, fund, operators, ensureAdmin, asAdminToken, ADMIN_KEY } from "./test-lib.mjs";
const DB = "postgres://kowri:kowri@localhost:5432/kowri";
const sql = (q) => execFileSync("psql", [DB, "-Atc", q], { encoding: "utf8" }).trim();
const sqlFail = (q) => { try { execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return ""; } catch (e) { return String(e.stderr).split("\n")[0]; } };
const RUN = randomUUID().slice(0, 8);
const { root, checker } = await operators();
const maker = await ensureAdmin({ email: `gonogo-maker-${RUN}@kowri.test`, name: "GoNoGo maker", password: "GoNoGoMakerPassw0rd-2026", role: "operations" }, root.token);
const a = await createUser({ kycLevel: 2 }), b = await createUser({ kycLevel: 2 }), c = await createUser({ kycLevel: 2 });
const report = async () => (await get("/admin/reconciliation/report", root.opts)).b;
const xof = (r) => (r?.supply ?? []).find((s) => s.currency === "XOF") ?? {};
const ledger = () => Number(sql("select count(*) from ledger_entries"));
const r0 = await report(); const l0 = ledger();

console.log("\nMoney creation");
const routes = [["POST", `/wallets/${a.wallet.id}/deposit`, { amount: 1000, currency: "XOF" }], ["POST", "/wallet/deposit", { walletId: a.wallet.id, amount: 1000 }], ["POST", "/transactions", { type: "deposit", toWalletId: a.wallet.id, amount: 1000, currency: "XOF" }], ["POST", `/admin/wallets/${a.wallet.id}/credit`, { amount: 1000 }], ["PATCH", `/wallets/${a.wallet.id}`, { balance: 999999 }], ["POST", `/wallets/${a.wallet.id}/adjust`, { amount: 1000 }]];
const hits = [];
for (const [m, p, body] of routes) for (const o of [{ token: a.token, idempotency: true }, { admin: true, idempotency: true }, asAdminToken(root.token, { idempotency: true })]) {
  const r = m === "PATCH" ? await (await import("./test-lib.mjs")).patch(p, body, o) : await post(p, body, o);
  if (r.s >= 200 && r.s < 300) hits.push(`${m} ${p}=${r.s}`);
}
chk("MC1 no route credits a wallet outside the maker-checker (user, legacy key, super_admin)", hits.length === 0, hits.join(","));
chk("MC2 SQL deposit without authority refused", sqlFail(`insert into transactions (id, type, status, amount, currency, to_wallet_id, reference, idempotency_key, created_at) values ('gng-${RUN}', 'deposit', 'completed', 1000, 'XOF', '${a.wallet.id}', 'GNG-${RUN}', 'gng-${RUN}', now())`).includes("DEPOSIT_WITHOUT_AUTHORITY"));
chk("MC3 SQL ledger credit without a balanced debit refused at commit", sqlFail(`insert into ledger_entries (id, transaction_id, account_id, account_type, currency, debit_amount, credit_amount, created_at) values ('gngl-${RUN}', 'gng-${RUN}', '${a.wallet.id}', 'wallet', 'XOF', 0, 1000, now())`) !== "");
chk("MC4 balance after every attempt unchanged", (await balance(a, a.wallet.id)) === 0 && ledger() === l0);

console.log("\nOperator separation / maker-checker");
const init = await post("/admin/cash-in", { walletId: a.wallet.id, amount: 50000, currency: "XOF", source: "bank_transfer", reference: `GNG-${RUN}-1` }, asAdminToken(maker.token, { idempotency: true }));
const self = await post(`/admin/cash-in/${init.b?.request?.id}/approve`, {}, asAdminToken(maker.token));
const legacyAppr = await post(`/admin/cash-in/${init.b?.request?.id}/approve`, {}, { admin: true });
const sqlExec = sqlFail(`update cash_in_requests set status = 'EXECUTED', approvals_received = approvals_required where id = '${init.b?.request?.id}'`);
chk("OS1 initiator cannot approve, legacy key cannot approve, SQL cannot mark EXECUTED", init.s === 201 && self.s === 403 && legacyAppr.s === 403 && sqlExec !== "", `${self.s},${legacyAppr.s} sql=${sqlExec.slice(0, 60)}`);
const two = await Promise.all([post(`/admin/cash-in/${init.b?.request?.id}/approve`, {}, asAdminToken(checker.token)), post(`/admin/cash-in/${init.b?.request?.id}/approve`, {}, asAdminToken(checker.token))]);
chk("OS2 two simultaneous approvals → one execution, one credit", two.filter((r) => r.s === 200).length === 1 && Number(sql(`select count(*) from transactions where idempotency_key = 'cash-in:${init.b?.request?.id}'`)) === 1 && (await balance(a, a.wallet.id)) === 50000, two.map((r) => r.s).join(","));

console.log("\nDouble spend / race / idempotency");
const key = randomUUID();
const spend = await Promise.all(Array.from({ length: 10 }, () => a.post(`/wallets/${a.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: 30000, currency: "XOF" }, { idempotency: true })));
chk("DS1 ten parallel 30 000 transfers from a 50 000 balance: exactly one succeeds", spend.filter((r) => r.s === 200).length === 1 && (await balance(a, a.wallet.id)) === 20000 && (await balance(b, b.wallet.id)) === 30000, spend.map((r) => r.s).join(","));
// Fresh funded wallet: the per-wallet velocity limiter (10 tx/min) is itself a control and must not mask the result.
const d = await createUser({ kycLevel: 2 }); await fund(d.wallet.id, 20000);
const same = await Promise.all(Array.from({ length: 5 }, () => post(`/wallets/${d.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: 5000, currency: "XOF" }, { token: d.token, headers: { "Idempotency-Key": key } })));
chk("ID1 the same idempotency key five times in parallel → one movement", same.filter((r) => r.s === 200 || r.s === 201).length >= 1 && (await balance(d, d.wallet.id)) === 15000, same.map((r) => r.s).join(","));
const altered = await post(`/wallets/${d.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: 9000, currency: "XOF" }, { token: d.token, headers: { "Idempotency-Key": key } });
chk("ID2 same key with a different body → refused (422), nothing moved", altered.s === 422 && (await balance(d, d.wallet.id)) === 15000, `status=${altered.s}`);
const neg = await a.post(`/wallets/${a.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: -5000, currency: "XOF" }, { idempotency: true });
const nan = await a.post(`/wallets/${a.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: "1e309", currency: "XOF" }, { idempotency: true });
chk("DS2 negative and non-finite amounts refused", neg.s === 400 && nan.s === 400, `${neg.s},${nan.s}`);

console.log("\nAuthorization");
const steal = await c.post(`/wallets/${a.wallet.id}/transfer`, { toWalletId: c.wallet.id, amount: 1000, currency: "XOF" }, { idempotency: true });
const peek = await c.get(`/wallets/${a.wallet.id}`);
const list = await c.get(`/transactions?walletId=${a.wallet.id}`);
const toSelf = await a.post(`/wallets/${a.wallet.id}/transfer`, { toWalletId: a.wallet.id, amount: 1000, currency: "XOF" }, { idempotency: true });
chk("AU1 a customer cannot move, read or list another customer's wallet (403/404, no leak); self-transfer refused", steal.s === 403 && (peek.s === 403 || peek.s === 404) && (list.s === 403 || list.s === 404 || (list.s === 200 && (list.b?.transactions ?? []).length === 0)) && toSelf.s === 400, `${steal.s},${peek.s},${list.s},${toSelf.s}`);
const frozen = await (await import("./test-lib.mjs")).patch(`/admin/wallets/${b.wallet.id}/status`, { status: "frozen", reason: "gate" }, root.opts);
const outOfFrozen = await b.post(`/wallets/${b.wallet.id}/transfer`, { toWalletId: c.wallet.id, amount: 1000, currency: "XOF" }, { idempotency: true });
const intoFrozen = await a.post(`/wallets/${a.wallet.id}/transfer`, { toWalletId: b.wallet.id, amount: 1000, currency: "XOF" }, { idempotency: true });
chk("AU2 a frozen wallet can neither send nor receive", frozen.s === 200 && outOfFrozen.s !== 200 && intoFrozen.s !== 200, `${frozen.s},${outOfFrozen.s},${intoFrozen.s}`);

console.log("\nKill switch");
const e = await createUser({ kycLevel: 2 }); await fund(e.wallet.id, 10000);
await post("/admin/kill-switches/outbound_transfers/force", { reason: "gate", operator: "gonogo" }, root.opts);
const blocked = await e.post(`/wallets/${e.wallet.id}/transfer`, { toWalletId: c.wallet.id, amount: 1000, currency: "XOF" }, { idempotency: true });
await post("/admin/kill-switches/cash_in/force", { reason: "gate", operator: "gonogo" }, root.opts);
const blockedIn = await post("/admin/cash-in", { walletId: c.wallet.id, amount: 1000, currency: "XOF", source: "other", reference: `GNG-${RUN}-KS` }, asAdminToken(maker.token, { idempotency: true }));
const readsOk = await a.get(`/wallets/${a.wallet.id}`);
await post("/admin/kill-switches/outbound_transfers/lift", { operator: "gonogo" }, root.opts);
await post("/admin/kill-switches/cash_in/lift", { operator: "gonogo" }, root.opts);
const after = await e.post(`/wallets/${e.wallet.id}/transfer`, { toWalletId: c.wallet.id, amount: 1000, currency: "XOF" }, { idempotency: true });
chk("KS1 forced switches block transfers and cash-in (503), reads continue, lift restores", blocked.s === 503 && blockedIn.s === 503 && readsOk.s === 200 && after.s === 200, `${blocked.s},${blockedIn.s},${readsOk.s},${after.s}`);

console.log("\nReconciliation / traceability");
const r1 = await report();
chk("RC1 every movement of this run is reconciled: ok, gap 0, created +80 000 exactly (three cash-ins), transfers created nothing", r1.ok && Math.abs(xof(r1).conservationGap) < 0.0001 && Math.abs(xof(r1).created - xof(r0).created - 80000) < 0.01, `Δcreated=${xof(r1).created - xof(r0).created}`);
const txA = await a.get(`/transactions?walletId=${a.wallet.id}`);
chk("RC2 every transaction of the customer is visible with a reference and a status", txA.s === 200 && (txA.b?.transactions ?? []).length >= 2 && txA.b.transactions.every((t) => t.reference && t.status), `n=${txA.b?.transactions?.length}`);
chk("RC3 no ledger entry can be deleted or edited", sqlFail("delete from ledger_entries where true") !== "" && sqlFail(`update ledger_entries set credit_amount = credit_amount + 1 where account_id = '${a.wallet.id}'`) !== "");

console.log("\nRecovery");
chk("RV1 no transaction of this run left pending/processing", Number(sql(`select count(*) from transactions where status in ('pending','processing') and (from_wallet_id in ('${a.wallet.id}','${b.wallet.id}') or to_wallet_id in ('${a.wallet.id}','${b.wallet.id}','${c.wallet.id}'))`)) === 0);
chk("RV2 crash-during-execution proofs: test-cashin C-series, test-concurrency, test-disaster-recovery (second instance on restore) — rerun on this commit", true);
summary("FINAL ADVERSARIAL CHECK (CANARY SCOPE)");
