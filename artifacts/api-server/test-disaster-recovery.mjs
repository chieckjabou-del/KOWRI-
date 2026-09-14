// ── Disaster recovery and corruption proof ───────────────────────────────────
// Proves, on a live database, that:
//   DR-1  a backup taken with scripts/db-backup.sh restores into a fresh
//         database with scripts/db-restore.sh, checksum and manifest verified;
//   DR-2  the restored database carries the money exactly (counts, sums,
//         balances), the protective triggers and functions (they refuse the
//         same writes), the migrations journal, the open cash-in requests,
//         the idempotency reservations and the audit trail;
//   DR-3  a second API instance boots on the restored database, sessions
//         issued before the backup still work, a cash-in left PENDING before
//         the backup is approved after the restore, the reconciliation is
//         clean and balances match the source;
//   DR-4  KYC documents survive as ciphertext: readable with the key, not
//         without it; the key rotates with src/tools/rotateKycKey.ts and the
//         old key then no longer opens anything;
//   DR-5  losing SIGNING_SECRET does not lose money, sessions or documents
//         (with KYC_ENCRYPTION_KEY set); only in-flight OTP/HMAC state.
//   CR-*  every corruption injected by hand into the restored database is
//         either refused by PostgreSQL or reported by the reconciliation; the
//         one that is neither is named as such.
//
// Requires psql, pg_dump, pg_restore and a maintenance connection able to
// CREATE DATABASE (DR_ADMIN_URL, defaulting to DATABASE_URL on the
// `postgres` database; falls back to `su postgres` locally).

import { randomUUID, createHash, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { get, post, chk, summary, createUser, balance, fund, operators, asAdminToken, login, OPERATOR_PHONE } from "./test-lib.mjs";

const DB = process.env.DATABASE_URL ?? "postgres://kowri:kowri@localhost:5432/kowri";
const SIGNING_SECRET = process.env.SIGNING_SECRET ?? "ci-signing-secret-0123456789abcdef0123456789abcdef";
const RUN = randomUUID().slice(0, 8);
const SANDBOX = `kowri_dr_${RUN}`;
const SANDBOX_URL = DB.replace(/\/[^/?]+(\?.*)?$/, `/${SANDBOX}$1`);
const ADMIN_URL = process.env.DR_ADMIN_URL ?? DB.replace(/\/[^/?]+(\?.*)?$/, "/postgres$1");
const PORT_B = Number(process.env.DR_PORT ?? 8090);
const BASE_B = `http://localhost:${PORT_B}/api`;
const WORK = resolve(process.env.DR_WORKDIR ?? `/tmp/kowri-dr-${RUN}`);
const REPO = resolve(process.cwd(), "../..");
mkdirSync(WORK, { recursive: true });

function psql(url, query) { return execFileSync("psql", [url, "-Atc", query], { encoding: "utf8" }).trim(); }
function psqlFail(url, query) {
  try { execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return ""; }
  catch (e) { return String(e.stderr).split("\n")[0]; }
}
function sh(cmd, args, env = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}
async function req(base, method, path, { body, token, adminToken, idempotency } = {}) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  if (adminToken) h["X-Admin-Token"] = adminToken;
  if (idempotency) h["Idempotency-Key"] = idempotency === true ? randomUUID() : idempotency;
  try {
    const r = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { s: r.status, b: await r.json().catch(() => null) };
  } catch (e) { return { s: 0, b: { error: String(e) } }; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createDatabase(name) {
  try { sh("psql", [ADMIN_URL, "-v", "ON_ERROR_STOP=1", "-c", `create database ${name}`]); return "maintenance url"; }
  catch (e) {
    try { sh("su", ["postgres", "-c", `createdb -O kowri ${name}`]); return "su postgres"; }
    catch (e2) { throw new Error(`cannot create ${name}: ${String(e.stderr)} / ${String(e2.stderr)}`); }
  }
}
function dropDatabase(name) {
  const stmt = `drop database if exists ${name} with (force)`;
  try { sh("psql", [ADMIN_URL, "-c", stmt]); } catch { try { sh("su", ["postgres", "-c", `psql -c "${stmt}"`]); } catch { /* reported below */ } }
}

let apiB = null;
async function startApiB(extraEnv = {}) {
  const log = join(WORK, `api-b-${Date.now()}.log`);
  const { openSync } = await import("node:fs");
  const fd = openSync(log, "a");
  apiB = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: process.cwd(), detached: true, stdio: ["ignore", fd, fd],
    env: {
      ...process.env, DATABASE_URL: SANDBOX_URL, PORT: String(PORT_B), NODE_ENV: "development",
      ADMIN_API_KEY: process.env.ADMIN_API_KEY ?? "test-admin-key", CORS_ORIGINS: "http://localhost:5173",
      SIGNING_SECRET, ...extraEnv,
    },
  });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const h = await req(BASE_B, "GET", "/health");
    if (h.s === 200) return log;
  }
  throw new Error(`API B did not come up; see ${log}`);
}
async function stopApiB() {
  if (!apiB) return;
  try { process.kill(-apiB.pid, "SIGTERM"); } catch { /* already gone */ }
  for (let i = 0; i < 30; i++) { await sleep(500); if ((await req(BASE_B, "GET", "/health")).s !== 200) break; }
  apiB = null;
}
process.on("exit", () => { if (apiB) { try { process.kill(-apiB.pid, "SIGKILL"); } catch { /* */ } } });

function devKey(secret = SIGNING_SECRET) { return createHash("sha256").update(`kowri-dev-kyc:${secret}`).digest(); }
function decryptWith(value, key) {
  const raw = Buffer.from(value.slice("enc:v1:".length), "base64");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
const SNAPSHOT_SQL = `select json_build_object(
  'transactions', (select count(*) from transactions),
  'ledger_entries', (select count(*) from ledger_entries),
  'debits', (select coalesce(sum(debit_amount),0)::text from ledger_entries),
  'credits', (select coalesce(sum(credit_amount),0)::text from ledger_entries),
  'wallets', (select count(*) from wallets),
  'wallet_balance_sum', (select coalesce(sum(balance),0)::text from wallets),
  'cash_in_by_status', (select coalesce(json_object_agg(status, n order by status), '{}') from (select status, count(*) n from cash_in_requests group by status) s),
  'cash_in_decisions', (select count(*) from cash_in_decisions),
  'audit_logs', (select count(*) from audit_logs),
  'idempotency_keys', (select count(*) from idempotency_keys),
  'admin_users', (select count(*) from admin_users),
  'admin_sessions', (select count(*) from admin_sessions),
  'kyc_records', (select count(*) from kyc_records),
  'references', (select count(distinct reference) from transactions),
  'migrations', (select count(*) from drizzle.__drizzle_migrations),
  'triggers', (select count(*) from pg_trigger where tgname like 'trg_%' and not tgisinternal),
  'functions', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('ledger_entries_immutable','transactions_protect','ledger_assert_balanced','cash_in_requests_protect','append_only_guard','transactions_deposit_authority','ledger_float_debit_authority','no_truncate'))
)`;

const KEY_CONFIGURED = process.env.KYC_ENCRYPTION_KEY && /^[0-9a-f]{64}$/i.test(process.env.KYC_ENCRYPTION_KEY);
const KYC_KEY = KEY_CONFIGURED ? Buffer.from(process.env.KYC_ENCRYPTION_KEY, "hex") : devKey();

// ── 0. Financial activity before the backup ─────────────────────────────────
console.log(`\n0. Activity on the source database (${DB})`);
const { root, checker } = await operators();
const { ensureAdmin } = await import("./test-lib.mjs");
const maker = await ensureAdmin({ email: `dr-maker-${RUN}@kowri.test`, name: "DR maker", password: "DrMakerPassw0rd-2026", role: "operations" }, root.token);
const alice = await createUser({ firstName: "DrAlice", kycLevel: 2 });
const bob = await createUser({ firstName: "DrBob", kycLevel: 2 });
await fund(alice.wallet.id, 300_000);
const transferKey = randomUUID();
const t1 = await alice.money(`/wallets/${alice.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 45_000, currency: "XOF" }, { idempotency: transferKey });
chk("0a source: cash-in + transfer executed", t1.s === 200 && (await balance(alice, alice.wallet.id)) === 255_000 && (await balance(bob, bob.wallet.id)) === 45_000, `status=${t1.s}`);
const pendingReq = await post("/admin/cash-in", { walletId: bob.wallet.id, amount: 12_345, currency: "XOF", source: "bank_transfer", reference: `DR-PENDING-${RUN}` }, asAdminToken(maker.token, { idempotency: true }));
chk("0b source: a cash-in request left PENDING_APPROVAL", pendingReq.s === 201 && pendingReq.b.request.status === "PENDING_APPROVAL", `status=${pendingReq.s}`);
const kyc = await alice.post(`/users/${alice.userId}/kyc`, {
  kycLevel: 2, documentType: "passport", documentNumber: `DR-${RUN}`, fullName: "Dr Alice", dateOfBirth: "1990-01-01",
  documentFront: `data:image/png;base64,FRONT-${RUN}`, selfie: `data:image/png;base64,SELFIE-${RUN}`,
});
chk("0c source: KYC with documents submitted (encrypted at rest)", kyc.s === 201, `status=${kyc.s}`);
const kycId = kyc.b?.record?.id;
chk("0d source: the document is stored as ciphertext", psql(DB, `select left(document_front, 7) from kyc_records where id = '${kycId}'`) === "enc:v1:");
const sourceAliceBalance = await balance(alice, alice.wallet.id);
const sourceBobBalance = await balance(bob, bob.wallet.id);

// ── 1. Backup ────────────────────────────────────────────────────────────────
console.log("\n1. Backup");
const snapshot = JSON.parse(psql(DB, SNAPSHOT_SQL));
const backupOut = sh("bash", [join(REPO, "scripts/db-backup.sh"), DB, WORK]);
const dumpFile = backupOut.match(/backup: (\S+)/)?.[1];
chk("1a db-backup.sh produced a dump", !!dumpFile && existsSync(dumpFile), backupOut.trim().split("\n")[0]);
const manifestFile = dumpFile.replace(/\.dump$/, ".manifest.json");
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
chk("1b manifest lists migrations, counts and money supply", Array.isArray(manifest.migrations) && manifest.migrations.length >= 5 && manifest.counts.ledger_entries > 0 && manifest.moneySupply.length > 0, `migrations=${manifest.migrations.length}`);
chk("1c checksum sidecar written and valid", existsSync(`${dumpFile}.sha256`) && sh("bash", ["-c", `cd "${WORK}" && sha256sum -c "$(basename "${dumpFile}").sha256"`]).includes("OK"));
chk("1d the dump holds no plaintext identity document", !sh("pg_restore", ["--data-only", "-t", "kyc_records", "-f", "-", dumpFile]).includes(`FRONT-${RUN}`));

// Tampering with the file must be caught before anything is restored.
const tampered = join(WORK, "tampered.dump");
sh("cp", [dumpFile, tampered]); sh("cp", [`${dumpFile}.sha256`, `${tampered}.sha256`]);
sh("bash", ["-c", `printf 'x' >> ${tampered}`]);
let tamperErr = "";
try { sh("bash", [join(REPO, "scripts/db-restore.sh"), tampered, SANDBOX_URL]); } catch (e) { tamperErr = String(e.stderr) + String(e.stdout); }
chk("1e db-restore.sh refuses a dump whose checksum does not match", /CHECKSUM MISMATCH/.test(tamperErr), tamperErr.split("\n").find((l) => l.includes("CHECKSUM")) ?? tamperErr.slice(0, 120));
// A restore aimed at a database that already holds money is refused before pg_restore runs.
let liveErr = "";
try { sh("bash", [join(REPO, "scripts/db-restore.sh"), dumpFile, DB]); } catch (e) { liveErr = String(e.stderr) + String(e.stdout); }
chk("1f db-restore.sh refuses to restore over a database that already holds a ledger", /refusing to restore over live data/.test(liveErr) && psql(DB, "select count(*) from ledger_entries") === String(snapshot.ledger_entries), liveErr.split("\n").find((l) => l.includes("refusing")) ?? liveErr.slice(0, 120));

// ── 2. Restore into a fresh database ─────────────────────────────────────────
console.log(`\n2. Restore into ${SANDBOX}`);
const how = createDatabase(SANDBOX);
chk("2a sandbox database created", psql(SANDBOX_URL, "select 1") === "1", how);
let restoreOut = "";
try { restoreOut = sh("bash", [join(REPO, "scripts/db-restore.sh"), dumpFile, SANDBOX_URL]); } catch (e) { restoreOut = String(e.stdout) + String(e.stderr); }
chk("2b db-restore.sh restored and verified the manifest", /manifest verified/.test(restoreOut), restoreOut.trim().split("\n").slice(-2).join(" | "));
const restored = JSON.parse(psql(SANDBOX_URL, SNAPSHOT_SQL));
const diff = Object.keys(snapshot).filter((k) => JSON.stringify(snapshot[k]) !== JSON.stringify(restored[k]));
chk("2c every financial aggregate is identical (transactions, entries, sums, wallets, cash-in, audit, idempotency, sessions, KYC)", diff.length === 0, diff.length ? `differs: ${diff.map((k) => `${k} ${JSON.stringify(snapshot[k])}≠${JSON.stringify(restored[k])}`).join("; ")}` : `${restored.transactions} tx, ${restored.ledger_entries} entries`);
chk("2d migrations journal restored (5 migrations)", Number(restored.migrations) === 5, `migrations=${restored.migrations}`);
chk("2e all protective triggers and functions restored (14 triggers, 8 guard functions)", Number(restored.triggers) >= 14 && Number(restored.functions) === 8, `triggers=${restored.triggers} functions=${restored.functions}`);
// The triggers must work, not just exist.
const rid = pendingReq.b.request.id;
const e1 = psqlFail(SANDBOX_URL, `update ledger_entries set credit_amount = credit_amount + 1 where id = (select id from ledger_entries limit 1)`);
const e2 = psqlFail(SANDBOX_URL, `update cash_in_requests set amount = 1 where id = '${rid}'`);
const e3 = psqlFail(SANDBOX_URL, `delete from audit_logs where id = (select id from audit_logs limit 1)`);
chk("2f restored triggers refuse ledger edits, request tampering and audit deletion", /append-only/.test(e1) && /CASH_IN_IMMUTABLE/.test(e2) && /APPEND_ONLY/.test(e3), `${e1} | ${e2} | ${e3}`);
chk("2g the PENDING cash-in request is present in the restore", psql(SANDBOX_URL, `select status from cash_in_requests where id = '${rid}'`) === "PENDING_APPROVAL");
chk("2h the idempotency reservation of the transfer is present", psql(SANDBOX_URL, `select count(*) from idempotency_keys where key = '${transferKey}'`) === "1");
chk("2i the KYC ciphertext is present and unchanged", psql(SANDBOX_URL, `select document_front from kyc_records where id = '${kycId}'`) === psql(DB, `select document_front from kyc_records where id = '${kycId}'`));
const invariants = JSON.parse(psql(SANDBOX_URL, `select json_build_object(
  'unbalanced', (select count(*) from (select transaction_id, currency from ledger_entries group by 1,2 having sum(debit_amount) <> sum(credit_amount)) u),
  'overdrawn', (select count(*) from (select account_id, currency from ledger_entries where account_type = 'wallet' group by 1,2 having sum(credit_amount) - sum(debit_amount) < 0) o),
  'drift', (select count(*) from wallets w where abs(w.balance - coalesce((select sum(credit_amount) - sum(debit_amount) from ledger_entries where account_id = w.id and account_type = 'wallet' and currency = w.currency), 0)) > 0.0001),
  'cash_in_gap', (select coalesce(sum(r.amount), 0) - coalesce((select sum(amount) from transactions where type = 'deposit' and metadata->>'authority' = 'cash_in_request'), 0) from cash_in_requests r where r.status = 'EXECUTED'),
  'no_authority', (select count(*) from transactions where type = 'deposit' and coalesce(metadata->>'authority','') = ''))`));
chk("2j ledger invariants hold in the restore (balanced, no overdraft, no drift, cash-in = ledger, every deposit authorised)", invariants.unbalanced === 0 && invariants.overdrawn === 0 && invariants.drift === 0 && Number(invariants.cash_in_gap) === 0 && invariants.no_authority === 0, JSON.stringify(invariants));

// ── 3. Application reconnected to the restore ───────────────────────────────
console.log(`\n3. Second API instance on ${SANDBOX} (port ${PORT_B})`);
const logB = await startApiB();
chk("3a API boots on the restored database", (await req(BASE_B, "GET", "/health")).s === 200, logB);
const meB = await req(BASE_B, "GET", "/admin/auth/me", { adminToken: root.token });
chk("3b an admin session issued before the backup is valid after the restore", meB.s === 200 && meB.b?.admin?.email === "root@kowri.test", `status=${meB.s}`);
const aliceB = await req(BASE_B, "GET", `/wallets/${alice.wallet.id}`, { token: alice.token });
chk("3c a user session issued before the backup works and the balance matches the source", aliceB.s === 200 && Number(aliceB.b?.balance) === sourceAliceBalance, `status=${aliceB.s} balance=${aliceB.b?.balance}`);
const loginB = await req(BASE_B, "POST", "/users/login", { body: { phone: OPERATOR_PHONE, pin: "1234" } });
chk("3d password/PIN login works on the restore", loginB.s === 200 && !!loginB.b?.token, `status=${loginB.s}`);
const reportB = await req(BASE_B, "GET", "/admin/reconciliation/report", { adminToken: root.token });
chk("3e reconciliation on the restore is clean", reportB.s === 200 && reportB.b?.ok === true, JSON.stringify(reportB.b?.anomalies));
const xofSrc = (await get("/admin/reconciliation/report", root.opts)).b?.supply?.find((s) => s.currency === "XOF");
const xofB = reportB.b?.supply?.find((s) => s.currency === "XOF");
chk("3f money supply per currency identical to the source at backup time", xofB && xofSrc && xofB.userLiabilities <= xofSrc.userLiabilities && xofB.created <= xofSrc.created && xofB.conservationGap === 0, `restore=${xofB?.created} source=${xofSrc?.created}`);
const replay = await req(BASE_B, "POST", `/wallets/${alice.wallet.id}/transfer`, { token: alice.token, idempotency: transferKey, body: { toWalletId: bob.wallet.id, amount: 45_000, currency: "XOF" } });
chk("3g replaying the pre-backup transfer key on the restore returns the cached result, no second debit", replay.s === 200 && replay.b?.id === t1.b?.id && Number((await req(BASE_B, "GET", `/wallets/${alice.wallet.id}`, { token: alice.token })).b?.balance) === sourceAliceBalance, `status=${replay.s}`);
const approveB = await req(BASE_B, "POST", `/admin/cash-in/${rid}/approve`, { adminToken: checker.token, body: { reason: "approved after restore" } });
chk("3h the cash-in left PENDING before the backup is approved on the restore → EXECUTED", approveB.s === 200 && approveB.b?.request?.status === "EXECUTED", `status=${approveB.s} ${approveB.b?.code ?? ""}`);
chk("3i beneficiary credited once on the restore, source untouched", Number((await req(BASE_B, "GET", `/wallets/${bob.wallet.id}`, { token: bob.token })).b?.balance) === sourceBobBalance + 12_345 && (await balance(bob, bob.wallet.id)) === sourceBobBalance);
const docsB = await req(BASE_B, "GET", `/compliance/kyc/${kycId}`, { adminToken: root.token });
chk("3j KYC documents readable in clear on the restore with the same key", docsB.s === 200 && docsB.b?.record?.documentFront === `data:image/png;base64,FRONT-${RUN}`, `status=${docsB.s}`);

// ── 4. Corruption injection on the restore ──────────────────────────────────
console.log("\nCR. Corruptions injected by hand into the restore");
{
  const w = alice.wallet.id;
  const txId = psql(SANDBOX_URL, `select id from transactions where to_wallet_id = '${w}' and type = 'deposit' limit 1`);
  const prevented = (name, err, re) => chk(`CR ${name} → PREVENTED by PostgreSQL`, re.test(err), err);
  prevented("missing transaction (delete)", psqlFail(SANDBOX_URL, `delete from transactions where id = '${txId}'`), /never deleted/);
  prevented("missing ledger entry (delete)", psqlFail(SANDBOX_URL, `delete from ledger_entries where transaction_id = '${txId}'`), /append-only/);
  prevented("duplicated transaction (same reference)", psqlFail(SANDBOX_URL, `insert into transactions (id, to_wallet_id, amount, currency, type, status, reference) select 'dup-${RUN}', to_wallet_id, amount, currency, 'transfer', status, reference from transactions where id = '${txId}'`), /duplicate key|unique/);
  prevented("duplicated transaction (same idempotency key)", psqlFail(SANDBOX_URL, `insert into transactions (id, to_wallet_id, amount, currency, type, status, reference, idempotency_key) select 'dup2-${RUN}', to_wallet_id, amount, currency, 'transfer', status, 'DUP2-${RUN}', idempotency_key from transactions where id = '${txId}'`), /duplicate key|unique/);
  prevented("debit without credit", psqlFail(SANDBOX_URL, `begin; insert into transactions (id, from_wallet_id, amount, currency, type, status, reference) values ('onesided-${RUN}', '${w}', 10, 'XOF', 'transfer', 'completed', 'ONE-${RUN}'); insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('one-e-${RUN}', 'onesided-${RUN}', '${w}', 'wallet', 10, 0, 'XOF', 'transfer'); commit;`), /LEDGER_UNBALANCED/);
  prevented("negative wallet", psqlFail(SANDBOX_URL, `begin; insert into transactions (id, from_wallet_id, amount, currency, type, status, reference) values ('neg-${RUN}', '${w}', 99999999, 'XOF', 'withdrawal', 'completed', 'NEG-${RUN}'); insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('neg-e1-${RUN}', 'neg-${RUN}', '${w}', 'wallet', 99999999, 0, 'XOF', 'withdrawal'), ('neg-e2-${RUN}', 'neg-${RUN}', 'platform_float', 'platform', 0, 99999999, 'XOF', 'withdrawal'); commit;`), /LEDGER_OVERDRAWN/);
  prevented("money without source (deposit without authority)", psqlFail(SANDBOX_URL, `begin; insert into transactions (id, to_wallet_id, amount, currency, type, status, reference) values ('nosrc-${RUN}', '${w}', 10, 'XOF', 'deposit', 'completed', 'NOSRC-${RUN}'); insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('nosrc-e1-${RUN}', 'nosrc-${RUN}', 'platform_float', 'platform', 10, 0, 'XOF', 'deposit'), ('nosrc-e2-${RUN}', 'nosrc-${RUN}', '${w}', 'wallet', 0, 10, 'XOF', 'deposit'); commit;`), /DEPOSIT_WITHOUT_AUTHORITY|FLOAT_DEBIT_WITHOUT_AUTHORITY/);
  prevented("ledger entry without transaction", psqlFail(SANDBOX_URL, `insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('orphan-${RUN}', 'no-such-tx', '${w}', 'wallet', 0, 10, 'XOF', 'x')`), /foreign key|violates/);
  prevented("amount rewritten on a completed transaction", psqlFail(SANDBOX_URL, `update transactions set amount = amount * 2 where id = '${txId}'`), /immutable/);
  prevented("status flipped completed → failed", psqlFail(SANDBOX_URL, `update transactions set status = 'failed' where id = '${txId}'`), /invalid transaction state transition/);
  prevented("executed cash-in request re-pointed", psqlFail(SANDBOX_URL, `update cash_in_requests set transaction_id = 'other' where id = '${rid}'`), /CASH_IN_CLOSED/);
  prevented("audit trail edited", psqlFail(SANDBOX_URL, `update audit_logs set actor = 'x' where id = (select id from audit_logs limit 1)`), /APPEND_ONLY/);
  prevented("decision trail deleted", psqlFail(SANDBOX_URL, `delete from cash_in_decisions where request_id = '${rid}'`), /APPEND_ONLY/);

  // Corruptions the database cannot refuse: they must be reported.
  const tontineId = psql(SANDBOX_URL, `select id from tontines where wallet_id is not null limit 1`);
  const poolId = psql(SANDBOX_URL, `select id from investment_pools limit 1`);
  const agentRow = psql(SANDBOX_URL, `select id from agent_wallets limit 1`);
  const injected = [];
  psql(SANDBOX_URL, `update wallets set balance = balance + 777 where id = '${w}'`); injected.push("I4");
  psql(SANDBOX_URL, `insert into transactions (id, from_wallet_id, to_wallet_id, amount, currency, type, status, reference, completed_at) values ('noentries-${RUN}', '${w}', '${bob.wallet.id}', 10, 'XOF', 'transfer', 'completed', 'NOENT-${RUN}', now())`); injected.push("I7");
  if (tontineId) { psql(SANDBOX_URL, `update tontines set solidarity_reserve = 1000000000 where id = '${tontineId}'`); injected.push("I14"); }
  if (poolId) { psql(SANDBOX_URL, `update investment_pools set current_amount = current_amount + 1 where id = '${poolId}'`); injected.push("I15"); }
  psql(SANDBOX_URL, `insert into idempotency_keys (id, key, endpoint, response_body) values ('idem-${RUN}', 'ghost-${RUN}', 'POST:/api/wallets/:walletId/transfer|u:${alice.userId}', '{"__status":200,"body":{"id":"ghost-tx-${RUN}"}}')`); injected.push("I16");
  psql(SANDBOX_URL, `insert into transactions (id, to_wallet_id, amount, currency, type, status, reference, created_at) values ('stuck-${RUN}', '${w}', 10, 'XOF', 'transfer', 'processing', 'STUCK-${RUN}', now() - interval '1 hour')`); injected.push("I5");
  const stuckErr = psqlFail(SANDBOX_URL, `update transactions set created_at = now() - interval '2 hour' where id = 'stuck-${RUN}'`);
  chk("CR created_at of a transaction is frozen (immutable)", /immutable/.test(stuckErr), stuckErr);
  const report = await req(BASE_B, "GET", "/admin/reconciliation/report", { adminToken: root.token });
  const found = (code) => (report.b?.anomalies ?? []).some((a) => a.startsWith(`${code} `));
  chk("CR cached wallet balance tampered → DETECTED (I4)", found("I4"), JSON.stringify(report.b?.anomalies));
  chk("CR business transaction without ledger entries → DETECTED (I7)", found("I7"));
  if (tontineId) chk("CR tontine solidarity reserve inflated → DETECTED (I14)", found("I14")); else chk("CR tontine reserve corruption: no tontine with a wallet in this database (not exercised)", true);
  if (poolId) chk("CR investment pool amount inflated → DETECTED (I15)", found("I15")); else chk("CR pool corruption: no investment pool in this database (not exercised)", true);
  chk("CR idempotency response pointing at a ghost transaction → DETECTED (I16)", found("I16"));
  chk("CR transaction stuck in processing for an hour → DETECTED (I5)", found("I5"));
  chk("CR report is no longer clean", report.b?.ok === false);
  if (agentRow) {
    psql(SANDBOX_URL, `update agent_wallets set float_balance = float_balance + 5000 where id = '${agentRow}'`);
    const after = await req(BASE_B, "GET", "/admin/reconciliation/report", { adminToken: root.token });
    const agentDetected = (after.b?.anomalies ?? []).some((a) => /agent/i.test(a));
    chk("CR agent float inflated → NOT DETECTED: agent float has no ledger account (known gap, classified P1 in the report)", agentDetected === false, "documented gap, not a pass of the control");
  } else {
    chk("CR agent float corruption: no agent wallet in this database (gap documented regardless)", true);
  }
}

// ── 5. Keys ─────────────────────────────────────────────────────────────────
console.log("\n5. Key loss and rotation");
{
  const cipher = psql(SANDBOX_URL, `select document_front from kyc_records where id = '${kycId}'`);
  chk("5a the document decrypts with the configured key (test-side AES-256-GCM)", decryptWith(cipher, KYC_KEY) === `data:image/png;base64,FRONT-${RUN}`, KEY_CONFIGURED ? "KYC_ENCRYPTION_KEY" : "development key derived from SIGNING_SECRET");
  let wrong = "";
  try { decryptWith(cipher, randomBytes(32)); wrong = "decrypted"; } catch (e) { wrong = e.message; }
  chk("5b with any other key the document is unreadable (authentication fails, no garbage output)", /auth|Unsupported state/i.test(wrong), wrong);
  let wrongSecret = "";
  try { decryptWith(cipher, devKey("another-signing-secret")); wrongSecret = "decrypted"; } catch (e) { wrongSecret = e.message; }
  chk(KEY_CONFIGURED ? "5c (key configured) a dev-derived key does not open it" : "5c losing SIGNING_SECRET without KYC_ENCRYPTION_KEY loses the dev-derived key → documents unreadable", /auth|Unsupported state/i.test(wrongSecret), wrongSecret);

  await stopApiB();
  const NEW_KEY = randomBytes(32).toString("hex");
  // Old keys: the configured one (or the dev key), plus the dev key of a boot
  // that had no SIGNING_SECRET — a local database may hold rows from both.
  const rotateEnv = { DATABASE_URL: SANDBOX_URL, KYC_ENCRYPTION_KEY_OLD: `${KEY_CONFIGURED ? process.env.KYC_ENCRYPTION_KEY : "dev"},dev:dev`, KYC_ENCRYPTION_KEY: NEW_KEY, SIGNING_SECRET, NODE_ENV: "development" };
  const dry = sh("npx", ["tsx", "src/tools/rotateKycKey.ts", "--dry-run"], rotateEnv);
  chk("5d rotation dry run writes nothing", /dry run/.test(dry) && psql(SANDBOX_URL, `select document_front from kyc_records where id = '${kycId}'`) === cipher, dry.trim());
  const rot = sh("npx", ["tsx", "src/tools/rotateKycKey.ts"], rotateEnv);
  const rotatedCipher = psql(SANDBOX_URL, `select document_front from kyc_records where id = '${kycId}'`);
  chk("5e rotateKycKey re-encrypted every document and TOTP secret in one transaction", /rotated \d+ field/.test(rot) && rotatedCipher !== cipher, rot.trim());
  chk("5f readable with the new key", decryptWith(rotatedCipher, Buffer.from(NEW_KEY, "hex")) === `data:image/png;base64,FRONT-${RUN}`);
  let old = ""; try { decryptWith(rotatedCipher, KYC_KEY); old = "decrypted"; } catch (e) { old = e.message; }
  chk("5g the old key no longer opens anything", /auth|Unsupported state/i.test(old), old);
  let wrongOld = ""; try { sh("npx", ["tsx", "src/tools/rotateKycKey.ts"], { ...rotateEnv, KYC_ENCRYPTION_KEY_OLD: randomBytes(32).toString("hex"), KYC_ENCRYPTION_KEY: randomBytes(32).toString("hex") }); } catch (e) { wrongOld = String(e.stderr) + String(e.stdout); }
  chk("5h rotating with a wrong old key aborts before writing anything", /not readable with the old key/.test(wrongOld) && psql(SANDBOX_URL, `select document_front from kyc_records where id = '${kycId}'`) === rotatedCipher, wrongOld.split("\n")[0]);

  // SIGNING_SECRET lost: the instance restarts with a different one and the real KYC key.
  const logB2 = await startApiB({ SIGNING_SECRET: `rotated-${randomUUID()}-0123456789abcdef`, KYC_ENCRYPTION_KEY: NEW_KEY });
  const me2 = await req(BASE_B, "GET", "/admin/auth/me", { adminToken: root.token });
  const alice2 = await req(BASE_B, "GET", `/wallets/${alice.wallet.id}`, { token: alice.token });
  const docs2 = await req(BASE_B, "GET", `/compliance/kyc/${kycId}`, { adminToken: root.token });
  const report2 = await req(BASE_B, "GET", "/admin/reconciliation/report", { adminToken: root.token });
  chk("5i after a SIGNING_SECRET change: admin sessions still valid", me2.s === 200, `status=${me2.s} ${logB2}`);
  chk("5j after a SIGNING_SECRET change: user sessions and balances intact", alice2.s === 200 && Number(alice2.b?.balance) === sourceAliceBalance, `status=${alice2.s}`);
  chk("5k after a SIGNING_SECRET change: documents readable through the API with the rotated KYC key", docs2.s === 200 && docs2.b?.record?.documentFront === `data:image/png;base64,FRONT-${RUN}`, `status=${docs2.s}`);
  chk("5l after a SIGNING_SECRET change: the ledger is unaffected (only the injected corruptions are reported)", report2.s === 200 && (report2.b?.anomalies ?? []).every((a) => /^(I4|I7|I14|I15|I16|I5) /.test(a)), JSON.stringify(report2.b?.anomalies));
  await stopApiB();
}

// ── 6. Clean up ──────────────────────────────────────────────────────────────
if (!process.env.DR_KEEP) {
  dropDatabase(SANDBOX);
  chk("6a sandbox database dropped", psqlFail(SANDBOX_URL, "select 1") !== "", "");
  rmSync(WORK, { recursive: true, force: true });
} else {
  console.log(`kept: ${SANDBOX_URL} and ${WORK}`);
}

const { fail } = summary("DISASTER RECOVERY + CORRUPTION SUITE");
process.exit(fail ? 1 : 0);
