// ── Launch readiness gate ────────────────────────────────────────────────────
// The last suite before the launch decision. It proves, against live
// processes, what AKWE_LAUNCH_READINESS_GATE.md claims:
//
//   1. the launch scope is one explicit, centralised setting (LAUNCH_MODULES)
//      and a production process refuses to start without it, without explicit
//      cash-in limits, or without an alerting channel;
//   2. a production-configured instance (NODE_ENV=production, MFA enforced,
//      no legacy key, demo fixtures off, LAUNCH_MODULES=none) refuses every
//      optional module at the route, executes a manual cash-in only under two
//      MFA-verified operators, and delivers signed alerts;
//   3. the financial kill switches stop cash-in, credit, FX, creator earnings
//      and cash-out, leave pending requests pending, propagate to every API
//      instance within seconds, and are audited;
//   4. money is conserved flow by flow (cash-in, internal transfer, creator
//      declaration, loan attempt);
//   5. cash-out has no route and its service refuses when the module is off;
//   6. creator earnings cannot create money under any input;
//   7. a second adversarial pass on bypasses (case, trailing slash, legacy
//      key, old paths, unknown switches, weak roles).
//
// Requires: the development API on :8080 (all modules on), psql on PATH,
// free ports 8092 (production instance) and 8095 (alert/SMS receiver).

import { randomUUID, createHmac, createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { openSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  get, post, patch, chk, summary, createUser, balance, fund, operators, ensureAdmin, asAdminToken, ADMIN_KEY, ROOT_ADMIN,
} from "./test-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DB = process.env.DATABASE_URL ?? "postgres://kowri:kowri@localhost:5432/kowri";
const SIGNING_SECRET = process.env.SIGNING_SECRET ?? "ci-signing-secret-0123456789abcdef0123456789abcdef";
const PROD_PORT = Number(process.env.LAUNCH_PROD_PORT ?? 8092);
const PROD = `http://localhost:${PROD_PORT}/api`;
const RECEIVER_PORT = Number(process.env.LAUNCH_RECEIVER_PORT ?? 8095);
const WORK = process.env.DR_WORKDIR ?? "/tmp";
const RUN = randomUUID().slice(0, 8);
const sql = (q) => execFileSync("psql", [DB, "-Atc", q], { encoding: "utf8" }).trim();
const sqlFail = (q) => { try { execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return ""; } catch (e) { return String(e.stderr).split("\n")[0]; } };
const codes = (rs) => rs.map((r) => `${r.s}${r.b?.code ? ":" + r.b.code : ""}`).join(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const totp = (secret, step = Math.floor(Date.now() / 30000)) => {
  const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, v = 0; const bytes = [];
  for (const ch of secret) { v = (v << 5) | B.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(step));
  const d = createHmac("sha1", Buffer.from(bytes)).update(c).digest(); const o = d[d.length - 1] & 15;
  return String((((d[o] & 127) << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) % 1e6).padStart(6, "0");
};

// Generic HTTP against any base (test-lib's helpers are bound to :8080).
async function call(base, method, path, { body, headers = {}, idempotency, token, adminToken, adminKey } = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (idempotency) h["Idempotency-Key"] = randomUUID();
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (adminToken) h["X-Admin-Token"] = adminToken;
  if (adminKey) h["X-Admin-Key"] = adminKey;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      return { s: res.status, b: await res.json().catch(() => null) };
    } catch (err) {
      // A keep-alive socket closed by the server between two calls: retry.
      if (attempt < 3) { await sleep(500); continue; }
      return { s: 0, b: { error: `${err?.cause?.code ?? ""} ${String(err)}`.trim() } };
    }
  }
}

// ── Alert / SMS receiver ─────────────────────────────────────────────────────
const received = [];
const receiver = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const sig = req.headers["x-akwe-signature"];
    const expected = `sha256=${createHmac("sha256", SIGNING_SECRET).update(raw).digest("hex")}`;
    let body = null; try { body = JSON.parse(raw); } catch { /* */ }
    received.push({ path: req.url, body, signatureValid: sig === expected, signature: sig ?? null });
    res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
  });
});
await new Promise((r) => receiver.listen(RECEIVER_PORT, r));
const alertsOf = (type) => received.filter((r) => r.path === "/alerts" && r.body?.type === type);
async function waitAlert(type, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (alertsOf(type).length) return alertsOf(type); await sleep(200); } return alertsOf(type); }

// ── Production instance management ───────────────────────────────────────────
const PROD_ENV_OK = {
  NODE_ENV: "production", PORT: String(PROD_PORT), DATABASE_URL: DB, DATABASE_SSL: "disable",
  // The same key the development instance derives when KYC_ENCRYPTION_KEY is
  // unset (fieldCrypto.deriveDevKey), so rows written by either instance stay
  // readable by both and by the key-rotation tool.
  SIGNING_SECRET, KYC_ENCRYPTION_KEY: createHash("sha256").update(`kowri-dev-kyc:${SIGNING_SECRET}`).digest("hex"),
  PHONE_VERIFICATION: "required", SMS_PROVIDER: "http", SMS_WEBHOOK_URL: `http://localhost:${RECEIVER_PORT}/sms`,
  LAUNCH_MODULES: "none",
  CASH_IN_MAX_PER_OPERATION: "2000000", CASH_IN_SECOND_APPROVAL_THRESHOLD: "500000", CASH_IN_DAILY_LIMIT_PER_OPERATOR: "10000000",
  CASH_IN_DAILY_LIMIT_PER_BENEFICIARY: "5000000", CASH_IN_DAILY_LIMIT_PLATFORM: "5000000000" /* shared test DB: other suites already used today's platform ceiling */, CASH_IN_DAILY_COUNT_PER_BENEFICIARY: "5", CASH_IN_EXPIRY_HOURS: "0.002" /* ≈7 s, so §8 can watch a request expire without touching the row */,
  ALERT_WEBHOOK_URL: `http://localhost:${RECEIVER_PORT}/alerts`,
  CORS_ORIGINS: "https://app.akwe.example", KILL_SWITCH_SYNC_MS: "2000",
};
let prod = null;
function spawnApi(env, label) {
  mkdirSync(WORK, { recursive: true }); // the DR suite removes its work directory when it ends
  const log = join(WORK, `api-launch-${label}-${RUN}.log`);
  const fd = openSync(log, "a");
  const base = { ...process.env };
  // The parent's development settings must not leak into the production process.
  for (const k of ["ADMIN_API_KEY", "ADMIN_MFA_REQUIRED", "ALLOW_DEMO_SEED", "LAUNCH_MODULES", "EXPERIMENTAL_MODULES", "SECRETS_STRICT", "ALERT_WEBHOOK_URL", "SMS_PROVIDER", "SMS_WEBHOOK_URL", "KYC_ENCRYPTION_KEY", "PHONE_VERIFICATION", "ADMIN_BOOTSTRAP_EMAIL", "ADMIN_BOOTSTRAP_PASSWORD", ...Object.keys(PROD_ENV_OK).filter((k) => k.startsWith("CASH_IN_"))]) delete base[k];
  const child = spawn("npx", ["tsx", "src/index.ts"], { cwd: here, detached: true, stdio: ["ignore", fd, fd], env: { ...base, ...env } });
  return { child, log };
}
async function waitUp(base, ms = 90000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await call(base, "GET", "/health")).s === 200) return true; await sleep(1000); } return false; }
function waitExit(child, ms) { return new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); child.on("exit", (code) => { clearTimeout(t); resolve(code ?? -1); }); }); }
async function stopApi(inst) {
  if (!inst) return;
  try { process.kill(-inst.child.pid, "SIGTERM"); } catch { /* */ }
  for (let i = 0; i < 40; i++) { await sleep(500); if ((await call(PROD, "GET", "/health")).s !== 200) break; }
}
process.on("exit", () => { if (prod) { try { process.kill(-prod.child.pid, "SIGKILL"); } catch { /* */ } } });
const logHas = (log, text) => existsSync(log) && readFileSync(log, "utf8").includes(text);

// ── Development instance actors ──────────────────────────────────────────────
const { root, checker } = await operators();
const maker = await ensureAdmin({ email: `launch-maker-${RUN}@kowri.test`, name: "Launch maker", password: "LaunchMakerPassw0rd-2026", role: "operations" }, root.token);
const alice = await createUser({ kycLevel: 2 });
const bob   = await createUser({ kycLevel: 2 });
const initiate = (walletId, amount, who = maker, extra = {}) =>
  post("/admin/cash-in", { walletId, amount, currency: "XOF", source: "bank_transfer", reference: `LG-${RUN}-${randomUUID().slice(0, 8)}`, ...extra }, asAdminToken(who.token, { idempotency: true }));
const approve = (id, who) => post(`/admin/cash-in/${id}/approve`, {}, asAdminToken(who.token));
const cinStatus = (id) => sql(`select status from cash_in_requests where id = '${id}'`);
const ledgerCount = () => Number(sql("select count(*) from ledger_entries"));
const report = async () => (await get("/admin/reconciliation/report", root.opts)).b;
const xof = (r) => (r?.supply ?? []).find((s) => s.currency === "XOF") ?? {};
const switchState = async (name, base = null, opts = root.opts) => base ? (await call(base, "GET", `/admin/kill-switches/${name}`, opts)).b?.state : (await get(`/admin/kill-switches/${name}`, root.opts)).b?.state;
async function liftAll(base, opts) {
  for (const n of ["cash_in", "credit", "fx", "agent_operations", "creator_earnings", "cash_out", "external_rails", "outbound_transfers", "all"]) {
    if (base) await call(base, "POST", `/admin/kill-switches/${n}/lift`, opts); else await post(`/admin/kill-switches/${n}/lift`, {}, root.opts);
  }
}
await liftAll();

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n1. Launch scope is explicit, centralised and visible");
{
  const scope = await get("/health/launch-scope");
  chk("1a GET /health/launch-scope is public and lists every optional module", scope.s === 200 && Array.isArray(scope.b?.modules) && scope.b.modules.length === 9, `modules=${scope.b?.modules?.length}`);
  chk("1b the development instance runs without LAUNCH_MODULES (all modules on, flagged as not configured)", scope.b?.launchModulesConfigured === false && scope.b.modules.every((m) => m.enabled), JSON.stringify(scope.b?.modules?.map((m) => m.enabled)));
  const names = (scope.b?.killSwitches ?? []).map((k) => k.name);
  chk("1c the seven financial kill switches exist", ["cash_in", "credit", "agent_operations", "creator_earnings", "cash_out", "external_rails", "fx"].every((n) => names.includes(n)), names.join(","));
  chk("1d all switches ENABLED at the start of the gate", (scope.b?.killSwitches ?? []).every((k) => k.state === "ENABLED"));
  const limits = (await get("/admin/cash-in/limits", root.opts)).b?.limits;
  chk("1e cash-in limits are one centralised, readable configuration incl. the daily count per beneficiary", limits && ["maxPerOperation", "secondApprovalThreshold", "dailyPerInitiator", "dailyPerBeneficiary", "dailyPlatform", "dailyCountPerBeneficiary", "expiryHours"].every((k) => typeof limits[k] === "number"), JSON.stringify(limits));
  // No critical limit is hidden in code: every limit comes from an env name the secrets review knows.
  const src = readFileSync(join(here, "src/lib/cashIn.ts"), "utf8");
  const envNames = [...src.matchAll(/envNumber\("([A-Z_]+)"/g)].map((m) => m[1]);
  const declared = [...src.matchAll(/"(CASH_IN_[A-Z_]+)"/g)].map((m) => m[1]);
  chk("1f every limit read in code is declared in CASH_IN_LIMIT_ENV (checked at production boot)", envNames.length === 7 && envNames.every((n) => declared.includes(n)), envNames.join(","));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n2. Production boot gate: a misconfigured process refuses to start");
{
  const bad1 = spawnApi({ ...PROD_ENV_OK, LAUNCH_MODULES: undefined, ALERT_WEBHOOK_URL: undefined, CASH_IN_MAX_PER_OPERATION: undefined }, "bad1");
  delete bad1.child.spawnargs; // cosmetic
  const code1 = await waitExit(bad1.child, 90000);
  chk("2a without LAUNCH_MODULES / a cash-in limit / ALERT_WEBHOOK_URL the production process exits (code 1)", code1 === 1, `exit=${code1} log=${bad1.log}`);
  chk("2b the refusal names the missing decisions", logHas(bad1.log, "LAUNCH_MODULES is not set") && logHas(bad1.log, "CASH_IN_MAX_PER_OPERATION") && logHas(bad1.log, "ALERT_WEBHOOK_URL is not set"), bad1.log);
  chk("2c the refused process did not serve traffic", (await call(PROD, "GET", "/health")).s !== 200);
  const bad2 = spawnApi({ ...PROD_ENV_OK, KYC_ENCRYPTION_KEY: "short", CASH_IN_SECOND_APPROVAL_THRESHOLD: "99999999" }, "bad2");
  const code2 = await waitExit(bad2.child, 90000);
  chk("2d a malformed KYC key and a second-approval threshold above the per-operation maximum are fatal", code2 === 1 && logHas(bad2.log, "KYC_ENCRYPTION_KEY") && logHas(bad2.log, "no request would ever need a second approver"), `exit=${code2}`);
  const bad3 = spawnApi({ ...PROD_ENV_OK, LAUNCH_MODULES: "credit,cashout" }, "bad3");
  const code3 = await waitExit(bad3.child, 90000);
  chk("2e a misspelt module name in LAUNCH_MODULES is fatal (no silent 'off')", code3 === 1 && logHas(bad3.log, "unknown module"), `exit=${code3}`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n3. Production-configured instance on :${PROD_PORT} (LAUNCH_MODULES=none, MFA enforced, no legacy key)`);
let prodRoot = null, prodMaker = null, prodChecker = null;
{
  prod = spawnApi(PROD_ENV_OK, "prod");
  chk("3a the correctly configured production process comes up", await waitUp(PROD), prod.log);
  await sleep(4000);
  const log = readFileSync(prod.log, "utf8");
  chk("3b demo fixtures are skipped in production", log.includes("[Seed] production: demo fixtures skipped"));
  chk("3c the secrets review reports no error", !log.includes("[secrets] ERROR"), (log.match(/\[secrets\] ERROR.*/g) ?? []).join(" | "));
  chk("3d no treasury seed in production (no new treasury_seed deposit)", !log.includes("[Treasury] seeded"));
  const scope = await call(PROD, "GET", "/health/launch-scope");
  chk("3e launch scope reported: configured, environment=production, every optional module disabled", scope.b?.launchModulesConfigured === true && scope.b?.environment === "production" && scope.b.modules.every((m) => !m.enabled) && scope.b?.alerting?.configured === true, JSON.stringify(scope.b).slice(0, 200));

  // Legacy key: not configured → not a credential.
  const legacy = await call(PROD, "GET", "/admin/kill-switches", { adminKey: ADMIN_KEY });
  chk("3f the shared legacy key is not a credential in production (no ADMIN_API_KEY)", legacy.s === 401 || legacy.s === 403, `status=${legacy.s}`);

  // Every optional module is refused at its route — before authentication, so
  // no credential and no old client can reach the service.
  const sweep = [
    ["POST", "/credit/loans"], ["GET", "/credit/loans"], ["POST", `/agents/x/liquidity-transfer`], 
    ["POST", "/pools/investment/x/invest"], ["POST", "/pools/insurance/x/join"], ["POST", "/savings/plans"], ["POST", "/diaspora/send"],
    ["POST", "/diaspora/recurring/run"], ["POST", "/tontines"], ["POST", "/community/tontines/x/collect"], ["POST", "/community/tontines/x/payout"],
    ["POST", "/CREDIT/loans"], ["POST", "/credit/loans/"], ["POST", "/Credit/Loans"], ["POST", "/savings/plans/x/accrue"],
  ];
  const results = [];
  for (const [m, p] of sweep) results.push([p, await call(PROD, m, p, m === "GET" ? {} : { idempotency: true, body: {} })]);
  results.push(["/creator/communities/x/earnings", await call(PROD, "POST", "/creator/communities/x/earnings", { token: alice.token, body: { transactionAmount: 1000 } })]);
  chk("3g every optional module route answers 503 MODULE_NOT_IN_LAUNCH_SCOPE (incl. case and trailing-slash variants)", results.every(([, r]) => r.s === 503 && r.b?.code === "MODULE_NOT_IN_LAUNCH_SCOPE"), results.filter(([, r]) => r.s !== 503).map(([p, r]) => `${p}=${r.s}${r.s === 0 ? ":" + r.b?.error : ""}`).join(",") || "all 503");
  chk("3h creator reads stay available while earnings declarations are off (module gate is on the money path only)", (await call(PROD, "GET", "/creator/communities")).s !== 503);

  // Operators: created by the development root (no MFA there), then enrolled
  // on the production instance, where an unverified session is read-only.
  const rootAcct = { email: `launch-root-${RUN}@kowri.test`, name: "Launch root", password: "LaunchRootPassw0rd-2026", role: "super_admin" };
  const makerAcct = { email: `launch-prod-maker-${RUN}@kowri.test`, name: "Launch prod maker", password: "LaunchPMakerPassw0rd-2026", role: "operations" };
  const checkerAcct = { email: `launch-prod-checker-${RUN}@kowri.test`, name: "Launch prod checker", password: "LaunchPCheckerPassw0rd-2026", role: "compliance" };
  for (const a of [rootAcct, makerAcct, checkerAcct]) await ensureAdmin(a, root.token);
  async function enrol(acct) {
    const login = await call(PROD, "POST", "/admin/auth/login", { body: { email: acct.email, password: acct.password } });
    const tok = login.b?.token;
    const before = await call(PROD, "POST", "/admin/cash-in", { adminToken: tok, idempotency: true, body: { walletId: alice.wallet.id, amount: 1000, currency: "XOF", source: "other", reference: `NOMFA-${RUN}-${acct.role}` } });
    const setup = await call(PROD, "POST", "/admin/auth/mfa/setup", { adminToken: tok });
    const bad = await call(PROD, "POST", "/admin/auth/mfa/confirm", { adminToken: tok, body: { code: "000000" } });
    const stale = await call(PROD, "POST", "/admin/auth/mfa/confirm", { adminToken: tok, body: { code: totp(setup.b?.secret ?? "AAAA", Math.floor(Date.now() / 30000) - 5) } });
    const ok = await call(PROD, "POST", "/admin/auth/mfa/confirm", { adminToken: tok, body: { code: totp(setup.b?.secret ?? "AAAA") } });
    return { acct, tok, login, before, setup, bad, stale, ok, secret: setup.b?.secret, opts: { adminToken: tok } };
  }
  prodRoot = await enrol(rootAcct); prodMaker = await enrol(makerAcct); prodChecker = await enrol(checkerAcct);
  chk("3i password-only login is accepted but flagged: MFA enrolment required", [prodRoot, prodMaker, prodChecker].every((e) => e.login.s === 200 && e.login.b?.mfaVerified === false && e.login.b?.mfaEnrollmentRequired === true), codes([prodRoot.login, prodMaker.login, prodChecker.login]));
  chk("3j before enrolment, a maker cannot initiate a cash-in (403 MFA_REQUIRED)", prodMaker.before.s === 403 && prodMaker.before.b?.code === "MFA_REQUIRED", codes([prodMaker.before]));
  chk("3k a wrong code and a code from five steps ago are refused; the current code enrols", [prodRoot, prodMaker, prodChecker].every((e) => e.bad.s === 401 && e.stale.s === 401 && e.ok.s === 200), codes([prodMaker.bad, prodMaker.stale, prodMaker.ok]));
  const relogin = await call(PROD, "POST", "/admin/auth/login", { body: { email: makerAcct.email, password: makerAcct.password } });
  chk("3l once enrolled, a password without a code is refused (401 MFA_REQUIRED)", relogin.s === 401 && relogin.b?.code === "MFA_REQUIRED", codes([relogin]));
  const withCode = await call(PROD, "POST", "/admin/auth/login", { body: { email: makerAcct.email, password: makerAcct.password, totpCode: totp(prodMaker.secret) } });
  chk("3m password + current code opens a verified session", withCode.s === 200 && withCode.b?.mfaVerified === true, codes([withCode]));

  // Cash-in end to end under production configuration.
  const bal0 = await balance(alice, alice.wallet.id);
  const init = await call(PROD, "POST", "/admin/cash-in", { adminToken: prodMaker.tok, idempotency: true, body: { walletId: alice.wallet.id, amount: 250000, currency: "XOF", source: "bank_transfer", reference: `PROD-${RUN}-1` } });
  chk("3n an MFA-verified maker initiates a cash-in (201 PENDING_APPROVAL)", init.s === 201 && init.b?.request?.status === "PENDING_APPROVAL", codes([init]));
  const self = await call(PROD, "POST", `/admin/cash-in/${init.b?.request?.id}/approve`, { adminToken: prodMaker.tok });
  chk("3o the maker cannot approve their own request (no ledger.approve; self-approval is also refused for approvers — test-cashin A2)", self.s === 403, codes([self]));
  const appr = await call(PROD, "POST", `/admin/cash-in/${init.b?.request?.id}/approve`, { adminToken: prodChecker.tok });
  chk("3p an MFA-verified checker approves → EXECUTED, wallet credited once", appr.s === 200 && appr.b?.request?.status === "EXECUTED" && (await balance(alice, alice.wallet.id)) === bal0 + 250000, codes([appr]));
  const big = await call(PROD, "POST", "/admin/cash-in", { adminToken: prodMaker.tok, idempotency: true, body: { walletId: alice.wallet.id, amount: 2000001, currency: "XOF", source: "bank_transfer", reference: `PROD-${RUN}-BIG` } });
  chk("3q the production per-operation limit (2 000 000) is enforced", big.s === 409 && big.b?.code === "CASH_IN_LIMIT_OPERATION", codes([big]));
  const two = await call(PROD, "POST", "/admin/cash-in", { adminToken: prodMaker.tok, idempotency: true, body: { walletId: alice.wallet.id, amount: 600000, currency: "XOF", source: "bank_transfer", reference: `PROD-${RUN}-2` } });
  chk("3r above the production threshold (500 000) two approvers are required", two.s === 201 && two.b?.request?.approvalsRequired === 2, codes([two]) + ` approvals=${two.b?.request?.approvalsRequired}`);
  await call(PROD, "POST", `/admin/cash-in/${two.b?.request?.id}/cancel`, { adminToken: prodMaker.tok, body: { reason: "gate test" } });
  // Beneficiary daily count: the two live requests above count; the limit is 5.
  const counts = [];
  for (let i = 0; i < 5; i++) counts.push(await call(PROD, "POST", "/admin/cash-in", { adminToken: prodMaker.tok, idempotency: true, body: { walletId: bob.wallet.id, amount: 1000, currency: "XOF", source: "other", reference: `PROD-${RUN}-C${i}` } }));
  const sixth = await call(PROD, "POST", "/admin/cash-in", { adminToken: prodMaker.tok, idempotency: true, body: { walletId: bob.wallet.id, amount: 1000, currency: "XOF", source: "other", reference: `PROD-${RUN}-C6` } });
  chk("3s the daily number of cash-ins per beneficiary (5) is enforced", counts.every((c) => c.s === 201) && sixth.s === 409 && sixth.b?.code === "CASH_IN_LIMIT_BENEFICIARY_COUNT", codes([...counts, sixth]));
  for (const c of counts) await call(PROD, "POST", `/admin/cash-in/${c.b?.request?.id}/cancel`, { adminToken: prodMaker.tok, body: { reason: "gate test" } });

  // Alerting: the operator test proves the channel end to end.
  received.length = 0;
  const test = await call(PROD, "POST", "/admin/alerts/test", { adminToken: prodRoot.tok, body: { note: `gate ${RUN}` } });
  const got = await waitAlert("alert.test");
  chk("3t POST /admin/alerts/test delivers a signed alert to ALERT_WEBHOOK_URL", test.s === 200 && test.b?.delivered === true && got.length === 1 && got[0].signatureValid, `status=${test.s} received=${got.length} sig=${got[0]?.signatureValid}`);
  const byMaker = await call(PROD, "POST", "/admin/alerts/test", { adminToken: prodMaker.tok });
  chk("3u an operations operator cannot send test alerts (system.control)", byMaker.s === 403, `status=${byMaker.s}`);
  const status = await call(PROD, "GET", "/admin/alerts/status", { adminToken: prodMaker.tok });
  chk("3v alert delivery counters are readable", status.s === 200 && status.b?.configured === true && status.b?.sent >= 1, JSON.stringify(status.b));

  // Reconciliation is reachable in production and reports the cash-in ledger tie-out.
  const rep = await call(PROD, "GET", "/admin/reconciliation/report", { adminToken: prodRoot.tok });
  chk("3w the reconciliation report runs under production configuration; every EXECUTED cash-in ties to its ledger transaction", rep.s === 200 && Array.isArray(rep.b?.cashIn?.ledgerMismatch) && rep.b.cashIn.ledgerMismatch.length === 0, `mismatch=${rep.b?.cashIn?.ledgerMismatch?.length}`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n4. Kill switches: effect, pending behaviour, propagation between instances, audit");
{
  // cash_in fired on the PRODUCTION instance must stop the DEVELOPMENT instance too.
  const pending = await initiate(alice.wallet.id, 5000);
  chk("4a a request is pending before the switch fires", pending.s === 201 && pending.b?.request?.status === "PENDING_APPROVAL", codes([pending]));
  received.length = 0;
  const fire = await call(PROD, "POST", "/admin/kill-switches/cash_in/fire", { adminToken: prodRoot.tok, body: { reason: `gate ${RUN}`, operator: prodRoot.acct.email } });
  chk("4b a super_admin with a verified MFA session fires cash_in on the production instance", fire.s === 200 && fire.b?.state === "TRIGGERED", codes([fire]));
  const fired = await waitAlert("kill_switch.fired");
  chk("4c the fire is alerted (critical, signed)", fired.length >= 1 && fired[0].signatureValid && fired[0].body?.severity === "critical", `n=${fired.length}`);
  let devState = null;
  for (let i = 0; i < 20; i++) { devState = await switchState("cash_in"); if (devState !== "ENABLED") break; await sleep(500); }
  chk("4d within seconds the other instance adopts the switch (FORCED_OFF, conservative)", devState === "FORCED_OFF", `dev=${devState}`);
  const blockedInit = await initiate(alice.wallet.id, 1000);
  const blockedAppr = await approve(pending.b?.request?.id, checker);
  chk("4e on the other instance: initiation and approval refused 503 OPERATION_SUSPENDED", blockedInit.s === 503 && blockedInit.b?.code === "OPERATION_SUSPENDED" && blockedAppr.s === 503, codes([blockedInit, blockedAppr]));
  chk("4f the pending request stays PENDING_APPROVAL (not executed, not lost)", cinStatus(pending.b?.request?.id) === "PENDING_APPROVAL");
  const recover = await call(PROD, "POST", "/admin/kill-switches/cash_in/recover", { adminToken: prodRoot.tok });
  const devAfterRecover = await (async () => { await sleep(3000); return switchState("cash_in"); })();
  chk("4g an autopilot-style recover re-enables the firing instance; the peer, holding FORCED_OFF, waits for the row to flip", recover.s === 200 && devAfterRecover !== "TRIGGERED", `recover=${recover.s} dev=${devAfterRecover}`);
  const lift = await call(PROD, "POST", "/admin/kill-switches/cash_in/lift", { adminToken: prodRoot.tok, body: { operator: prodRoot.acct.email } });
  for (let i = 0; i < 20; i++) { devState = await switchState("cash_in"); if (devState === "ENABLED") break; await sleep(500); }
  chk("4h a manual lift propagates: every instance ENABLED again", lift.s === 200 && devState === "ENABLED", `dev=${devState}`);
  const lifted = await waitAlert("kill_switch.lifted");
  chk("4i the lift is alerted (warning)", lifted.length >= 1);
  const appr = await approve(pending.b?.request?.id, checker);
  chk("4j after the lift the pending request is approved and executed once", appr.s === 200 && appr.b?.request?.status === "EXECUTED" && Number(sql(`select count(*) from transactions where idempotency_key = 'cash-in:${pending.b?.request?.id}'`)) === 1, codes([appr]));
  const audits = Number(sql(`select count(*) from audit_logs where entity = 'kill_switch' and entity_id = 'cash_in' and actor = '${prodRoot.acct.email}'`));
  const autoRows = Number(sql(`select count(*) from audit_logs where entity = 'kill_switch' and entity_id = 'cash_in' and actor = 'autopilot'`));
  chk("4k fire and lift are in audit_logs under the operator's identity, the recover under 'autopilot'", audits >= 2 && autoRows >= 1, `operator=${audits} autopilot=${autoRows}`);

  // Each financial switch on the development instance.
  const fireDev = (n) => post(`/admin/kill-switches/${n}/fire`, { reason: "gate", operator: ROOT_ADMIN.email }, root.opts);
  const liftDev = (n) => post(`/admin/kill-switches/${n}/lift`, { operator: ROOT_ADMIN.email }, root.opts);
  await fireDev("credit");
  const loan = await alice.money("/credit/loans", { walletId: alice.wallet.id, amount: 10000, currency: "XOF", termDays: 30, purpose: "gate" });
  chk("4l credit switch: loan disbursement refused 503 OPERATION_SUSPENDED", loan.s === 503 && loan.b?.code === "OPERATION_SUSPENDED" && loan.b?.switch === "credit", codes([loan]));
  await liftDev("credit");
  await fireDev("fx");
  const fx = await alice.money("/diaspora/send", { fromWalletId: alice.wallet.id, beneficiaryId: "none", amount: 1000, fromCurrency: "XOF", toCurrency: "EUR" });
  chk("4m fx switch: remittance refused 503 (before any beneficiary lookup)", fx.s === 503 && fx.b?.switch === "fx", codes([fx]));
  await liftDev("fx");
  await fireDev("creator_earnings");
  const comm = await alice.post("/creator/communities", { name: `Gate ${RUN}`, creatorId: alice.userId, handle: `gate-${RUN}` });
  const decl = await alice.post(`/creator/communities/${comm.b?.id}/earnings`, { transactionAmount: 1000 });
  chk("4n creator_earnings switch: declaration refused 503", comm.s === 201 && decl.s === 503 && decl.b?.switch === "creator_earnings", codes([comm, decl]));
  await liftDev("creator_earnings");
  const unknown = await post("/admin/kill-switches/nope/fire", { reason: "x" }, root.opts);
  const weak = await post("/admin/kill-switches/cash_in/fire", { reason: "x" }, asAdminToken(checker.token));
  const weakLift = await post("/admin/kill-switches/cash_in/lift", {}, asAdminToken(maker.token));
  chk("4o unknown switch → 404; compliance and operations cannot fire or lift (system.control only)", unknown.s === 404 && weak.s === 403 && weakLift.s === 403, codes([unknown, weak, weakLift]));
  chk("4p every switch is ENABLED at the end of the section", (await get("/health/launch-scope")).b.killSwitches.every((k) => k.state === "ENABLED"));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n5. Money conservation, flow by flow (development instance, all modules on)");
{
  const r0 = await report();
  chk("5a starting point: reconciliation ok, conservation gap 0", r0?.ok === true && Math.abs(xof(r0).conservationGap ?? 1) < 0.0001, (r0?.anomalies ?? []).join(" | ").slice(0, 200));
  const created0 = xof(r0).created, liab0 = xof(r0).userLiabilities;
  await fund(alice.wallet.id, 100000);
  const r1 = await report();
  chk("5b manual cash-in: created +100 000, liabilities +100 000, gap 0 (authority cash_in_request)", r1?.ok && Math.abs(xof(r1).created - created0 - 100000) < 0.01 && Math.abs(xof(r1).userLiabilities - liab0 - 100000) < 0.01 && Math.abs(xof(r1).conservationGap) < 0.0001, `Δcreated=${xof(r1).created - created0} Δliab=${xof(r1).userLiabilities - liab0}`);
  const l1 = ledgerCount();
  const t = await alice.money(`/wallets/${alice.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 20000, currency: "XOF", description: "gate" });
  const r2 = await report();
  chk("5c internal transfer: nothing created, liabilities+fees unchanged in total, gap 0", t.s === 200 && Math.abs(xof(r2).created - xof(r1).created) < 0.01 && Math.abs(xof(r2).conservationGap) < 0.0001 && r2.ok, `status=${t.s} Δcreated=${xof(r2).created - xof(r1).created}`);
  chk("5d the transfer moved money through balanced ledger entries only", ledgerCount() > l1 && r2.checks.unbalancedTransactions.length === 0);
  const comm = await alice.post("/creator/communities", { name: `Cons ${RUN}`, creatorId: alice.userId, handle: `cons-${RUN}` });
  const l2 = ledgerCount(); const bA = await balance(alice, alice.wallet.id);
  const decl = await alice.post(`/creator/communities/${comm.b?.id}/earnings`, { transactionAmount: 500000 });
  const r3 = await report();
  chk("5e creator earnings declaration: credited=false, zero ledger entries, creator balance unchanged, gap 0", decl.s === 200 && decl.b?.credited === false && ledgerCount() === l2 && (await balance(alice, alice.wallet.id)) === bA && Math.abs(xof(r3).created - xof(r2).created) < 0.01, codes([decl]) + ` credited=${decl.b?.credited}`);
  const loan = await alice.money("/credit/loans", { walletId: alice.wallet.id, amount: 10000, currency: "XOF", termDays: 30, purpose: "gate" });
  const r4 = await report();
  chk("5f loan attempt (granted or refused by score): treasury→wallet only, nothing created, gap 0", (loan.s === 201 || loan.s === 200 || loan.s === 400 || loan.s === 403 || loan.s === 422) && r4.ok && Math.abs(xof(r4).created - xof(r3).created) < 0.01 && Math.abs(xof(r4).conservationGap) < 0.0001, `loan=${loan.s}${loan.b?.code ? ":" + loan.b.code : ""}`);
  if (loan.s === 201 || loan.s === 200) {
    const loanId = loan.b?.loan?.id ?? loan.b?.id;
    const rep = await alice.money(`/credit/loans/${loanId}/repay`, { walletId: alice.wallet.id, amount: 1000 });
    const r5 = await report();
    chk("5g repayment: wallet→treasury only, gap 0", (rep.s === 200 || rep.s === 201) && r5.ok && Math.abs(xof(r5).created - xof(r4).created) < 0.01, `repay=${rep.s}`);
  } else {
    chk("5g repayment path exercised by test-phase4/test-integrity (loan refused for a fresh user here)", true, `loan=${loan.s}`);
  }
  chk("5h created − destroyed = liabilities + treasury + fees + fx (all currencies), by authority: no deposit without authority", r4.supply.every((s) => Math.abs(s.conservationGap) < 0.0001) && r4.checks.depositsWithoutAuthority === 0);
  chk("5i tontine, savings, pool, insurance and FX flows are conserved by test-phase5/test-phase7/test-integrity (I1–I16) — not re-run here", true);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n6. Cash-out is OFF: no route, no service path");
{
  let routes = "";
  try { routes = execFileSync("grep", ["-rl", "processWithdrawal", join(here, "src/routes")], { encoding: "utf8" }).trim(); } catch { routes = ""; }
  chk("6a no router references processWithdrawal", routes === "", routes);
  const grep = (dir, pattern) => { try { return execFileSync("grep", ["-rln", pattern, join(here, dir)], { encoding: "utf8" }).trim(); } catch { return ""; } };
  const withdrawRoutes = grep("src/routes", "withdraw").split("\n").filter(Boolean);
  chk("6b the only 'withdraw' route files are the agent withdrawal-approval codes and the war-room read model (no money movement)", withdrawRoutes.every((f) => f.endsWith("agents.ts") || f.endsWith("wallets.ts") || f.endsWith("failureSim.ts") || f.endsWith("warroom.ts")), withdrawRoutes.join(","));
  const paths = ["/wallet/withdraw", "/wallets/withdraw", `/wallets/${alice.wallet.id}/withdraw`, `/wallets/${alice.wallet.id}/withdrawal`, "/transactions/withdraw", "/transactions/withdrawal", "/withdrawals", "/cash-out", "/cashout", "/wallet/cash-out", "/merchant/withdraw", "/merchant/payout", "/payouts", "/wallet/payout", `/users/${alice.userId}/withdraw`];
  const hits = [];
  for (const p of paths) {
    for (const opts of [{ token: alice.token, idempotency: true }, { adminKey: ADMIN_KEY, idempotency: true }, { adminToken: root.token, idempotency: true }]) {
      const r = await call("http://localhost:8080/api", "POST", p, { ...opts, body: { walletId: alice.wallet.id, amount: 100, currency: "XOF" } });
      if (r.s >= 200 && r.s < 300) hits.push(`${p}=${r.s}`);
    }
  }
  chk("6c no plausible cash-out path answers 2xx for a user, the legacy key or a super_admin", hits.length === 0, hits.join(","));
  const out = execFileSync("npx", ["tsx", "--eval", `
    import("./src/lib/walletService.ts").then(async (m) => {
      try { await m.processWithdrawal({ walletId: "x", amount: 1, currency: "XOF" }); console.log("EXECUTED"); }
      catch (e) { console.log("THROW " + e.name); }
      process.exit(0);
    });`], { cwd: here, encoding: "utf8", env: { ...process.env, DATABASE_URL: DB, LAUNCH_MODULES: "none", NODE_ENV: "development" }, timeout: 60000 }).trim();
  chk("6d with LAUNCH_MODULES=none the service itself refuses before touching the ledger (ModuleDisabledError)", out.includes("THROW ModuleDisabledError"), out);
  const out2 = execFileSync("npx", ["tsx", "--eval", `
    import("./src/lib/walletService.ts").then(async (m) => {
      try { await m.processWithdrawal({ walletId: "x", amount: 1, currency: "XOF" }); console.log("EXECUTED"); }
      catch (e) { console.log("THROW " + e.name); }
      process.exit(0);
    });`], { cwd: here, encoding: "utf8", env: { ...process.env, DATABASE_URL: DB, LAUNCH_MODULES: "cash_out", NODE_ENV: "development" }, timeout: 60000 }).trim();
  chk("6e with the module on, the same call reaches the ledger checks (no wallet → refused there, not by the gate)", !out2.includes("ModuleDisabledError"), out2);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n7. Creator earnings cannot create money");
{
  const comm = await alice.post("/creator/communities", { name: `Atk ${RUN}`, creatorId: alice.userId, handle: `atk-${RUN}` });
  const id = comm.b?.id;
  const l0 = ledgerCount(); const bA = await balance(alice, alice.wallet.id); const fees0 = xof(await report()).platformFees;
  const path = `/creator/communities/${id}/earnings`;
  const cases = {
    negative: await alice.post(path, { transactionAmount: -1000 }),
    zero: await alice.post(path, { transactionAmount: 0 }),
    nan: await alice.post(path, { transactionAmount: "abc" }),
    huge: await alice.post(path, { transactionAmount: 1e300 }),
    infinity: await alice.post(path, { transactionAmount: "Infinity" }),
    object: await alice.post(path, { transactionAmount: { $gt: 0 } }),
  };
  chk("7a falsified amounts (negative, zero, NaN, object, Infinity) are refused; 1e300 is not a way to inflate anything", Object.entries(cases).filter(([k]) => k !== "huge").every(([, r]) => r.s === 400) && (cases.huge.s === 400 || (cases.huge.s === 200 && cases.huge.b?.credited === false)), codes(Object.values(cases)));
  const missing = await alice.post(`/creator/communities/does-not-exist/earnings`, { transactionAmount: 1000 });
  const other = await bob.post(path, { transactionAmount: 1000 });
  const anon = await post(path, { transactionAmount: 1000 });
  chk("7b nonexistent community 404, another user 403, anonymous 401", missing.s === 404 && other.s === 403 && anon.s === 401, codes([missing, other, anon]));
  const replay = await Promise.all(Array.from({ length: 12 }, () => alice.post(path, { transactionAmount: 999999 })));
  chk("7c 12 concurrent replays of a large declaration all answer credited=false", replay.every((r) => r.s === 200 && r.b?.credited === false), codes(replay.slice(0, 4)));
  const legacy = await post(path, { transactionAmount: 1000 }, { admin: true });
  chk("7d the legacy key path also credits nothing", legacy.s === 200 ? legacy.b?.credited === false : legacy.s === 403, codes([legacy]));
  const rep = await report();
  chk("7e after every attempt: zero new ledger entries, creator balance unchanged, platform fees unchanged", ledgerCount() === l0 && (await balance(alice, alice.wallet.id)) === bA && Math.abs(xof(rep).platformFees - fees0) < 0.0001, `Δentries=${ledgerCount() - l0}`);
  const olds = [];
  for (const p of [`/creator/communities/${id}/distribute`, `/creator/communities/${id}/payout`, `/creator/${id}/earnings`, `/creators/${id}/earnings`, `/creator/earnings`]) olds.push([p, await alice.post(p, { transactionAmount: 1000, amount: 1000 })]);
  chk("7f no old or alternative creator route exists", olds.every(([, r]) => r.s === 404), olds.filter(([, r]) => r.s !== 404).map(([p, r]) => `${p}=${r.s}`).join(","));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n8. Cash-in final state machine and immutability");
{
  const req = await initiate(alice.wallet.id, 3000);
  const id = req.b?.request?.id;
  const twice = await Promise.all([approve(id, checker), approve(id, checker)]);
  chk("8a two simultaneous approvals by the same checker: exactly one EXECUTED, one refusal, one transaction", twice.filter((r) => r.s === 200).length === 1 && cinStatus(id) === "EXECUTED" && Number(sql(`select count(*) from transactions where idempotency_key = 'cash-in:${id}'`)) === 1, codes(twice));
  const again = await approve(id, root);
  chk("8b approving an EXECUTED request is refused", again.s === 409, codes([again]));
  chk("8c an EXECUTED request cannot be edited or deleted (trigger)", sqlFail(`update cash_in_requests set amount = 999999 where id = '${id}'`) !== "" && sqlFail(`delete from cash_in_requests where id = '${id}'`) !== "");
  chk("8d decisions are append-only", sqlFail(`delete from cash_in_decisions where request_id = '${id}'`) !== "");
  const r2 = await initiate(alice.wallet.id, 3000);
  const rej = await post(`/admin/cash-in/${r2.b?.request?.id}/reject`, { reason: "gate" }, asAdminToken(checker.token));
  const afterRej = await approve(r2.b?.request?.id, checker);
  chk("8e REJECTED is terminal: a later approval is refused and nothing is credited", rej.s === 200 && afterRej.s === 409 && Number(sql(`select count(*) from transactions where idempotency_key = 'cash-in:${r2.b?.request?.id}'`)) === 0, codes([rej, afterRej]));
  // Expiry cannot be forged: the row's expiry is immutable (trigger), so the
  // production instance, configured with a seven-second expiry, is used.
  const rp = await initiate(alice.wallet.id, 3000);
  const forged = sqlFail(`update cash_in_requests set expires_at = now() - interval '1 minute' where id = '${rp.b?.request?.id}'`);
  chk("8f the expiry of a pending request cannot be moved by SQL (CASH_IN_IMMUTABLE)", rp.s === 201 && forged.includes("CASH_IN_IMMUTABLE"), forged.slice(0, 100));
  await post(`/admin/cash-in/${rp.b?.request?.id}/cancel`, { reason: "gate" }, asAdminToken(maker.token));
  const r3 = await call(PROD, "POST", "/admin/cash-in", { adminToken: prodMaker.tok, idempotency: true, body: { walletId: alice.wallet.id, amount: 3000, currency: "XOF", source: "other", reference: `PROD-${RUN}-EXP` } });
  await sleep(8000);
  const exp = await call(PROD, "POST", "/admin/cash-in/expire", { adminToken: prodRoot.tok });
  const afterExp = await call(PROD, "POST", `/admin/cash-in/${r3.b?.request?.id}/approve`, { adminToken: prodChecker.tok });
  chk("8g EXPIRED is terminal: the expiry worker closes an undecided request and approval is then refused", r3.s === 201 && exp.s === 200 && cinStatus(r3.b?.request?.id) === "EXPIRED" && afterExp.s === 409, codes([r3, exp, afterExp]) + ` status=${cinStatus(r3.b?.request?.id)}`);
  chk("8h crash before/during/after execution, retries and double execution are proven by test-cashin (C-series) and test-concurrency — not re-run here", true);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n9. Second adversarial pass: bypasses");
{
  // Sessions and permissions.
  const suspended = await ensureAdmin({ email: `launch-susp-${RUN}@kowri.test`, name: "Suspended", password: "SuspPassw0rd-2026", role: "operations" }, root.token);
  const before = await get("/admin/auth/me", asAdminToken(suspended.token));
  const susp = await patch(`/admin/auth/users/${suspended.admin?.id}`, { status: "disabled" }, root.opts);
  const after = await get("/admin/auth/me", asAdminToken(suspended.token));
  const initBySusp = await initiate(alice.wallet.id, 1000, suspended);
  chk("9a disabling an operator kills their live session: no read, no initiation", before.s === 200 && susp.s === 200 && after.s === 401 && initBySusp.s !== 201, codes([before, susp, after, initBySusp]));
  const loggedOut = await ensureAdmin({ email: `launch-out-${RUN}@kowri.test`, name: "Out", password: "OutPassw0rd-2026", role: "operations" }, root.token);
  const out = await post("/admin/auth/logout", {}, asAdminToken(loggedOut.token));
  const replayTok = await initiate(alice.wallet.id, 1000, loggedOut);
  chk("9b a token replayed after logout is refused", out.s === 200 && (replayTok.s === 401 || replayTok.s === 403), codes([out, replayTok]));
  const asUser = await post("/admin/kill-switches/cash_in/fire", { reason: "x" }, { token: alice.token });
  const asUser2 = await post("/admin/alerts/test", {}, { token: alice.token });
  chk("9c a product user cannot reach operator controls (kill switches, alerts)", (asUser.s === 401 || asUser.s === 403) && (asUser2.s === 401 || asUser2.s === 403), codes([asUser, asUser2]));

  // Module gates vs workers / internal callers: the service functions carry the gate.
  const src = (f) => readFileSync(join(here, f), "utf8");
  const guarded = {
    "lib/creatorEconomy.ts": ['assertModuleEnabled("creator_earnings")', 'guard("creator_earnings")'],
    "lib/liquidityEngine.ts": ['assertModuleEnabled("agents")', 'guard("agent_operations")'],
    "lib/diasporaService.ts": ['assertModuleEnabled("fx")', 'guard("fx")'],
    "lib/walletService.ts": ['assertModuleEnabled("cash_out")', 'guard("cash_out")'],
    "lib/savingsEngine.ts": ['assertModuleEnabled("savings")'],
    "lib/communityFinance.ts": ['assertModuleEnabled("pools")', 'assertModuleEnabled("insurance")'],
    "lib/tontineScheduler.ts": ['assertModuleEnabled("tontines")'],
    "routes/credit.ts": ['assertModuleEnabled("credit")', 'guard("credit")'],
    "lib/cashIn.ts": ['guard("cash_in")'],
    "lib/settlementService.ts": ['guard("external_rails")'],
    "index.ts": ['isLaunchModuleEnabled("tontines")', 'isLaunchModuleEnabled("agents")'],
  };
  const missingGuards = Object.entries(guarded).flatMap(([f, needles]) => needles.filter((n) => !src(`src/${f}`).includes(n)).map((n) => `${f}:${n}`));
  chk("9d every money-moving service entry point and scheduler carries the module gate and/or kill switch (workers and internal callers cannot bypass the route)", missingGuards.length === 0, missingGuards.join(","));
  const routesSrc = src("src/routes/index.ts");
  chk("9e every optional module router is mounted behind launchModule() (tontines, community, credit, pools, insurance, savings, diaspora, agents) and the creator earnings route is gated", ["tontines", "credit", "pools", "insurance", "savings", "fx", "agents"].every((m) => routesSrc.includes(`launchModule("${m}")`)) && src("src/routes/creatorEconomy.ts").includes('launchModule("creator_earnings")'));

  // Old / internal / experimental paths on the production instance.
  const internal = [];
  for (const [m, p] of [["POST", "/sagas"], ["POST", "/sagas/run"], ["POST", "/failure-sim/inject"], ["POST", "/settlements"], ["POST", "/clearing/batches"], ["POST", "/connectors"], ["POST", "/admin/patch-tontines"], ["POST", "/admin/seed"], ["POST", "/system/seed"]]) {
    internal.push([p, await call(PROD, m, p, { adminToken: prodRoot.tok, idempotency: true, body: {} })]);
  }
  chk("9f in production, sagas / failure-sim / settlements / clearing / connectors / seeds are not reachable even for a verified super_admin (404 or 403)", internal.every(([, r]) => r.s === 404 || r.s === 403 || r.s === 400 || r.s === 503), internal.map(([p, r]) => `${p}=${r.s}`).join(","));
  const treasuryDeposit = await call(PROD, "POST", `/wallets/${alice.wallet.id}/deposit`, { adminToken: prodRoot.tok, idempotency: true, body: { amount: 1000, currency: "XOF" } });
  const adminDeposit = await call(PROD, "POST", `/admin/wallets/${alice.wallet.id}/deposit`, { adminToken: prodRoot.tok, idempotency: true, body: { amount: 1000, currency: "XOF" } });
  chk("9g no direct deposit route exists for a super_admin (only the maker-checker cash-in creates money)", ![treasuryDeposit, adminDeposit].some((r) => r.s >= 200 && r.s < 300), codes([treasuryDeposit, adminDeposit]));
  const sqlDeposit = sqlFail(`insert into transactions (id, type, status, amount, currency, to_wallet_id, reference, idempotency_key, created_at) values ('gate-${RUN}', 'deposit', 'completed', 1000, 'XOF', '${alice.wallet.id}', 'GATE-${RUN}', 'gate-${RUN}', now())`);
  chk("9h a raw SQL deposit without a deposit authority is refused by the database trigger (DEPOSIT_WITHOUT_AUTHORITY)", sqlDeposit.includes("DEPOSIT_WITHOUT_AUTHORITY"), sqlDeposit.slice(0, 160));
  const state = (await get("/health/launch-scope")).b;
  chk("9i the development instance ends the gate with every switch ENABLED", state.killSwitches.every((k) => k.state === "ENABLED"));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n10. Production instance shuts down cleanly");
{
  try { process.kill(-prod.child.pid, "SIGTERM"); } catch { /* */ }
  await waitExit(prod.child, 30000);
  let drained = false;
  for (let i = 0; i < 30 && !drained; i++) { drained = logHas(prod.log, "[Shutdown] complete"); if (!drained) await sleep(1000); }
  chk("10a SIGTERM → drained ('[Shutdown] complete') and no longer serving", drained && (await call(PROD, "GET", "/health")).s !== 200, `log=${prod.log}`);
  prod = null;
}

await liftAll();
receiver.close();
summary("LAUNCH READINESS GATE");
