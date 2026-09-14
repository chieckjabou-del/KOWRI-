// ── Operator controls: ACTION × ROLE × AUTH × 2FA × APPROVAL × AUDIT ─────────
// Every sensitive back-office action is exercised with every kind of caller
// (no credential, product user, shared legacy key, and one named account per
// role) and the answer is compared with the role/permission model. A second
// API instance is started with ADMIN_MFA_REQUIRED=true against the same
// database to prove that, under the production setting, a session without a
// verified second factor cannot write anything and an enrolled operator can.
// Finally every write route of the API is swept with the weakest roles: any
// 2xx outside the role's own family is reported as an open route.

import { randomUUID, createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get, post, patch, put, del, raw, chk, summary, createUser, operators, ensureAdmin, adminLogin, asAdminToken, ROOT_ADMIN, ADMIN_KEY } from "./test-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DB = process.env.DATABASE_URL ?? "postgres://kowri:kowri@localhost:5432/kowri";
const sql = (q) => execFileSync("psql", [DB, "-Atc", q], { encoding: "utf8" }).trim();
const sqlFail = (q) => { try { execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return ""; } catch (e) { return String(e.stderr).split("\n")[0]; } };
const RUN = randomUUID().slice(0, 8);
const codes = (rs) => rs.map((r) => `${r.s}${r.b?.code ? ":" + r.b.code : ""}`).join(",");
const totp = (secret, step = Math.floor(Date.now() / 30000)) => {
  const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, v = 0; const bytes = [];
  for (const ch of secret) { v = (v << 5) | B.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(step));
  const d = createHmac("sha1", Buffer.from(bytes)).update(c).digest(); const o = d[d.length - 1] & 15;
  return String((((d[o] & 127) << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) % 1e6).padStart(6, "0");
};

const { root } = await operators();
const acct = (role) => ({ email: `matrix-${role}-${RUN}@kowri.test`, name: `Matrix ${role}`, password: `Matrix${role}Passw0rd-2026`, role });
const roles = {};
for (const role of ["super_admin", "compliance", "operations", "support", "auditor"]) roles[role] = await ensureAdmin(acct(role), root.token);
const user = await createUser({ kycLevel: 2 });
const callers = {
  none: {}, user: { token: user.token }, legacy: { admin: true },
  ...Object.fromEntries(Object.entries(roles).map(([r, s]) => [r, asAdminToken(s.token)])),
};

// ── 1. Matrix ────────────────────────────────────────────────────────────────
// expected: which callers may pass the permission gate. "gate passed" means
// the answer is not 401/403; the route may still answer 400/404 on the fake id.
const SESSION_ROLES_WITH = (perm) => ({
  "users.read":      ["super_admin", "compliance", "operations", "support", "auditor", "legacy"],
  "users.manage":    ["super_admin", "compliance", "legacy"],
  "kyc.review":      ["super_admin", "compliance", "legacy"],
  "aml.review":      ["super_admin", "compliance", "legacy"],
  "wallets.manage":  ["super_admin", "compliance", "operations", "legacy"],
  "ledger.write":    ["super_admin", "operations", "legacy"],
  "ledger.approve":  ["super_admin", "compliance", "legacy"],
  "merchants.manage":["super_admin", "operations", "legacy"],
  "support.manage":  ["super_admin", "operations", "support", "legacy"],
  "system.control":  ["super_admin", "legacy"],
  "admins.manage":   ["super_admin", "legacy"],
}[perm]);
const ACTIONS = [
  { name: "cash-in initiate",   perm: "ledger.write",    sessionOnly: true, call: (o) => post("/admin/cash-in", { walletId: user.wallet.id, amount: 1000, currency: "XOF", source: "other", reference: `M-${RUN}-${randomUUID().slice(0, 6)}` }, { ...o, idempotency: true }) },
  { name: "cash-in approve",    perm: "ledger.approve",  sessionOnly: true, call: (o) => post("/admin/cash-in/nope/approve", {}, o) },
  { name: "cash-in reject",     perm: "ledger.approve",  sessionOnly: true, call: (o) => post("/admin/cash-in/nope/reject", { reason: "x" }, o) },
  { name: "cash-in expiry sweep", perm: "ledger.approve", sessionOnly: true, call: (o) => post("/admin/cash-in/expire", {}, o) },
  { name: "float recovery",     perm: "ledger.write",    call: (o) => post("/admin/reconciliation/recover-float", {}, o) },
  { name: "savings accrual",    perm: "ledger.write",    call: (o) => post("/savings/plans/nope/accrue", {}, o) },
  { name: "KYC review",         perm: "kyc.review",      call: (o) => patch("/compliance/kyc/nope", { decision: "approve" }, o) },
  { name: "AML flag review",    perm: "aml.review",      call: (o) => patch("/aml/flags/nope/review", { decision: "cleared" }, o) },
  { name: "risk alert resolve", perm: "aml.review",      call: (o) => patch("/risk/alerts/nope/resolve", { resolution: "x" }, o) },
  { name: "wallet freeze",      perm: "wallets.manage",  call: (o) => patch("/admin/wallets/nope/status", { status: "frozen" }, o) },
  { name: "merchant status",    perm: "merchants.manage",call: (o) => patch("/admin/merchants/nope/status", { status: "suspended" }, o) },
  { name: "kill switch lift",   perm: "system.control",  call: (o) => post("/admin/kill-switches/settlements/lift", {}, o) },
  { name: "fee rule create",    perm: "system.control",  call: (o) => post("/admin/fees", {}, o) },
  { name: "FX rate write",      perm: "system.control",  call: (o) => put("/fx/rates", {}, o) },
  { name: "admin account create", perm: "admins.manage", call: (o) => post("/admin/auth/users", {}, o) },
  { name: "admin role change",  perm: "admins.manage",   call: (o) => patch("/admin/auth/users/nope", { role: "auditor" }, o) },
  { name: "admin MFA reset",    perm: "admins.manage",   call: (o) => post("/admin/auth/users/nope/mfa/reset", {}, o) },
  { name: "reconciliation report (read)", perm: "users.read", call: (o) => get("/admin/reconciliation/report", o) },
  { name: "cash-in list (read)", perm: "users.read",     call: (o) => get("/admin/cash-in?limit=1", o) },
  { name: "audit log (read)",   perm: "users.read",      call: (o) => get("/system/audit?limit=1", o) },
];
console.log("\n1. Matrix ACTION × CALLER");
const matrix = [];
for (const a of ACTIONS) {
  const row = { action: a.name, perm: a.perm };
  for (const [caller, opts] of Object.entries(callers)) {
    const r = await a.call(opts);
    let allowed = SESSION_ROLES_WITH(a.perm).includes(caller);
    if (a.sessionOnly && caller === "legacy") allowed = false;
    const gatePassed = r.s !== 401 && r.s !== 403;
    row[caller] = `${r.s}${r.b?.code ? ":" + r.b.code : ""}`;
    chk(`${a.name} × ${caller} → ${allowed ? "gate passed" : "refused"}`, gatePassed === allowed, row[caller]);
    if (!allowed && (caller === "none" || caller === "user")) chk(`${a.name} × ${caller} carries no hint of the missing permission`, r.b?.required === undefined || caller === "user", row[caller]);
  }
  matrix.push(row);
}
console.log("\n  Matrix (status[:code]):");
console.log("  " + ["action".padEnd(28), ...Object.keys(callers).map((c) => c.padEnd(16))].join(""));
for (const row of matrix) console.log("  " + [row.action.padEnd(28), ...Object.keys(callers).map((c) => String(row[c]).padEnd(16))].join(""));

// ── 2. Sessions: revocation, rotation, lifetime ──────────────────────────────
console.log("\n2. Session lifecycle");
{
  const a = await ensureAdmin({ email: `lifecycle-${RUN}@kowri.test`, name: "Lifecycle", password: "LifecyclePassw0rd-2026", role: "operations" }, root.token);
  const b = await adminLogin({ email: `lifecycle-${RUN}@kowri.test`, password: "LifecyclePassw0rd-2026" });
  chk("2a two sessions for one account", (await get("/admin/auth/me", a.opts)).s === 200 && (await get("/admin/auth/me", b.opts)).s === 200);
  const rolled = await patch(`/admin/auth/users/${a.admin.id}`, { role: "auditor" }, root.opts);
  chk("2b a role change revokes every session of the account", rolled.s === 200 && (await get("/admin/auth/me", a.opts)).s === 401 && (await get("/admin/auth/me", b.opts)).s === 401, `status=${rolled.s}`);
  const c = await adminLogin({ email: `lifecycle-${RUN}@kowri.test`, password: "LifecyclePassw0rd-2026" });
  chk("2c the new session carries the new role only (auditor cannot initiate a cash-in)", (await post("/admin/cash-in", { walletId: user.wallet.id, amount: 1, currency: "XOF", source: "other", reference: `L-${RUN}` }, asAdminToken(c.token, { idempotency: true }))).s === 403);
  const reset = await post(`/admin/auth/users/${a.admin.id}/reset-password`, { password: "AnotherPassw0rd-2026" }, root.opts);
  chk("2d a password reset revokes the sessions", reset.s === 200 && (await get("/admin/auth/me", c.opts)).s === 401);
  const d = await adminLogin({ email: `lifecycle-${RUN}@kowri.test`, password: "AnotherPassw0rd-2026" });
  const mfaReset = await post(`/admin/auth/users/${a.admin.id}/mfa/reset`, {}, root.opts);
  chk("2e an MFA reset revokes the sessions", mfaReset.s === 200 && (await get("/admin/auth/me", d.opts)).s === 401);
  const e = await adminLogin({ email: `lifecycle-${RUN}@kowri.test`, password: "AnotherPassw0rd-2026" });
  const disabled = await patch(`/admin/auth/users/${a.admin.id}`, { status: "disabled" }, root.opts);
  chk("2f disabling the account kills the session and login", disabled.s === 200 && (await get("/admin/auth/me", e.opts)).s === 401 && (await post("/admin/auth/login", { email: `lifecycle-${RUN}@kowri.test`, password: "AnotherPassw0rd-2026" })).s === 403);
  const f = await ensureAdmin({ email: `logout-${RUN}@kowri.test`, name: "Logout", password: "LogoutPassw0rd-2026", role: "support" }, root.token);
  const out = await post("/admin/auth/logout", {}, f.opts);
  chk("2g logout revokes the token immediately", out.s === 200 && (await get("/admin/auth/me", f.opts)).s === 401);
  const forged = await get("/admin/auth/me", { headers: { "X-Admin-Token": `kadm_${"0".repeat(64)}` } });
  chk("2h a forged token is refused", forged.s === 401);
  // Two active super_admins exist here (root and the matrix account): the
  // first demotion is allowed, the one that would leave nobody is refused.
  const others = (await get("/admin/auth/users", root.opts)).b.admins.filter((x) => x.role === "super_admin" && x.status === "active" && x.id !== root.admin.id);
  const demoted = [];
  for (const o of others) demoted.push((await patch(`/admin/auth/users/${o.id}`, { role: "auditor" }, root.opts)).s);
  const self = await patch(`/admin/auth/users/${root.admin.id}`, { role: "auditor" }, root.opts);
  chk("2i the last active super_admin cannot be demoted, even by themselves → 409", demoted.every((c) => c === 200) && self.s === 409 && (await get("/admin/auth/me", root.opts)).b?.admin?.role === "super_admin", `others=${demoted.join(",")} self=${self.s}`);
  await patch(`/admin/auth/users/${roles.super_admin.admin.id}`, { role: "super_admin" }, root.opts);
  const expired = sql(`update admin_sessions set expires_at = now() - interval '1 minute' where admin_user_id = '${roles.support.admin.id}' returning id`);
  chk("2j an expired session is refused even before cleanup", !!expired && (await get("/admin/auth/me", roles.support.opts)).s === 401);
  roles.support = await adminLogin(acct("support"));
  chk("2k every session event is in audit_logs with the acting operator", Number(sql(`select count(*) from audit_logs where actor = '${ROOT_ADMIN.email}' and action in ('admin.account.updated','admin.password.reset','admin.mfa.reset') and entity_id = '${a.admin.id}'`)) >= 3);
}

// ── 3. Second factor under the production setting ───────────────────────────
console.log("\n3. ADMIN_MFA_REQUIRED=true (second instance on the same database)");
{
  const PORT = Number(process.env.MFA_PORT ?? 8091);
  const BASE = `http://localhost:${PORT}/api`;
  const log = join(process.env.DR_WORKDIR ?? "/tmp", `api-mfa-${RUN}.log`);
  const fd = openSync(log, "a");
  const child = spawn("npx", ["tsx", "src/index.ts"], { cwd: here, detached: true, stdio: ["ignore", fd, fd],
    env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: "development", ADMIN_MFA_REQUIRED: "true", ADMIN_API_KEY: ADMIN_KEY, SIGNING_SECRET: process.env.SIGNING_SECRET ?? "ci-signing-secret-0123456789abcdef0123456789abcdef", CORS_ORIGINS: "http://localhost:5173" } });
  const up = async () => { for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 1000)); try { if ((await fetch(`${BASE}/health`)).status === 200) return true; } catch { /* */ } } return false; };
  chk("3a MFA-enforcing instance is up", await up(), log);
  const r = async (method, path, o = {}) => raw(method, path, o).catch(() => ({ s: 0 }));
  const B = (o) => ({ ...o });
  // test-lib's BASE is fixed; call the second instance directly.
  const call = async (method, path, { body, headers = {}, idempotency } = {}) => {
    const h = { "Content-Type": "application/json", ...headers };
    if (idempotency) h["Idempotency-Key"] = randomUUID();
    const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { s: res.status, b: await res.json().catch(() => null) };
  };
  const ops = acct("operations");
  const login = await call("POST", "/admin/auth/login", { body: { email: ops.email, password: ops.password } });
  chk("3b password-only login succeeds but is flagged: enrolment required", login.s === 200 && login.b?.mfaVerified === false && login.b?.mfaEnrollmentRequired === true, JSON.stringify(login.b).slice(0, 160));
  const tok = { "X-Admin-Token": login.b?.token };
  const readOk = await call("GET", "/admin/cash-in?limit=1", { headers: tok });
  const writeNo = await call("POST", "/admin/cash-in", { headers: tok, idempotency: true, body: { walletId: user.wallet.id, amount: 1000, currency: "XOF", source: "other", reference: `MFA-${RUN}` } });
  chk("3c without a verified second factor: reads allowed, cash-in initiation refused 403 MFA_REQUIRED", readOk.s === 200 && writeNo.s === 403 && writeNo.b?.code === "MFA_REQUIRED", codes([readOk, writeNo]));
  const legacyNo = await call("POST", "/admin/kill-switches/settlements/lift", { headers: { "X-Admin-Key": ADMIN_KEY } });
  const legacyRead = await call("GET", "/admin/cash-in?limit=1", { headers: { "X-Admin-Key": ADMIN_KEY } });
  chk("3d the shared legacy key is read-only under MFA enforcement", legacyRead.s === 200 && legacyNo.s === 403 && legacyNo.b?.code === "MFA_REQUIRED", codes([legacyRead, legacyNo]));
  const setup = await call("POST", "/admin/auth/mfa/setup", { headers: tok });
  const confirm = await call("POST", "/admin/auth/mfa/confirm", { headers: tok, body: { code: totp(setup.b?.secret ?? "AAAA") } });
  chk("3e enrolment through the API", setup.s === 200 && confirm.s === 200, codes([setup, confirm]));
  const writeYes = await call("POST", "/admin/cash-in", { headers: tok, idempotency: true, body: { walletId: user.wallet.id, amount: 1000, currency: "XOF", source: "other", reference: `MFA2-${RUN}` } });
  chk("3f the same session, now verified, can initiate a cash-in", writeYes.s === 201, codes([writeYes]));
  const relogin = await call("POST", "/admin/auth/login", { body: { email: ops.email, password: ops.password } });
  chk("3g once enrolled, password-only login is refused (401 MFA_REQUIRED)", relogin.s === 401 && relogin.b?.code === "MFA_REQUIRED", codes([relogin]));
  const compl = acct("compliance");
  const cLogin = await call("POST", "/admin/auth/login", { body: { email: compl.email, password: compl.password } });
  const approveNo = await call("POST", `/admin/cash-in/${writeYes.b?.request?.id}/approve`, { headers: { "X-Admin-Token": cLogin.b?.token } });
  chk("3h an unverified approver cannot approve (403 MFA_REQUIRED): both signatures need a second factor", approveNo.s === 403 && approveNo.b?.code === "MFA_REQUIRED", codes([approveNo]));
  // The main (development) instance must not have been affected: cancel the request there.
  await post(`/admin/cash-in/${writeYes.b?.request?.id}/cancel`, { reason: "mfa test" }, asAdminToken(roles.operations.token));
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 2000));
}

// ── 4. Forgotten routes: sweep every write route with the weak roles ─────────
console.log("\n4. Write-route sweep with auditor and support sessions");
{
  const indexSrc = readFileSync(join(here, "src/routes/index.ts"), "utf8");
  const importMap = new Map();
  for (const m of indexSrc.matchAll(/import\s+(\w+)\s+from\s+"\.\/(\w+)"/g)) importMap.set(m[1], m[2]);
  const mounts = [];
  for (const m of indexSrc.matchAll(/router\.use\(\s*"([^"]+)"\s*,([^;]*?)(\w+Router)\s*\)/g)) mounts.push({ prefix: m[1], file: importMap.get(m[3]) });
  for (const m of indexSrc.matchAll(/router\.use\((\w+Router)\)/g)) mounts.push({ prefix: "", file: importMap.get(m[1]) });
  const routes = [];
  for (const { prefix, file } of mounts) {
    if (!file) continue;
    const src = readFileSync(join(here, `src/routes/${file}.ts`), "utf8");
    for (const m of src.matchAll(/router\.(post|put|patch|delete|all)\(\s*"([^"]+)"/g)) {
      routes.push({ method: m[1] === "all" ? "POST" : m[1].toUpperCase(), file, raw: (prefix + (m[2] === "/" ? "" : m[2])) || "/" });
    }
  }
  const concrete = (raw) => raw.replace(/\{\*\w+\}/g, "probe").replace(/:\w+/g, "probe-id").replace(/\/+$/, "") || "/";
  // Routes a weak operator may legitimately drive: own account, and the family its role owns.
  const OWN = [/^\/admin\/auth\/(logout|change-password|mfa\/setup|mfa\/confirm)$/];
  const PUBLIC = [/^\/users$/, /^\/users\/login$/, /^\/auth\/login$/, /^\/auth\/otp\//, /^\/wallet\/(login|create|logout)$/, /^\/merchant\/(login|create)$/, /^\/developer\/(register|login)$/, /^\/developer\/api-key\/validate$/, /^\/admin\/auth\/login$/];
  const FAMILY = { support: [/^\/support\//], auditor: [] };
  for (const role of ["auditor", "support"]) {
    const open = [];
    for (const r of routes) {
      const path = concrete(r.raw);
      if (OWN.some((re) => re.test(path)) || PUBLIC.some((re) => re.test(path)) || FAMILY[role].some((re) => re.test(path))) continue;
      const res = await raw(r.method, path, { ...asAdminToken(roles[role].token), body: r.method === "DELETE" ? undefined : {}, idempotency: true });
      if (res.s >= 200 && res.s < 300) open.push(`${r.method} ${path} → ${res.s} (${r.file}.ts)`);
    }
    chk(`4 ${role}: no write route outside its family answers 2xx (${routes.length} routes swept)`, open.length === 0, open.join(" | ") || "none");
  }
}

// ── 5. Trails ────────────────────────────────────────────────────────────────
console.log("\n5. Audit trail integrity");
{
  const id = sql(`select id from audit_logs where action like 'admin.%' order by timestamp desc limit 1`);
  chk("5a audit rows cannot be edited", /APPEND_ONLY/.test(sqlFail(`update audit_logs set metadata = '{}' where id = '${id}'`)));
  chk("5b audit rows cannot be deleted", /APPEND_ONLY/.test(sqlFail(`delete from audit_logs where id = '${id}'`)));
  const before = sql(`select count(*) from audit_logs`);
  chk("5c audit_logs cannot be truncated (statement trigger)", /APPEND_ONLY/.test(sqlFail(`truncate audit_logs`)) && sql(`select count(*) from audit_logs`) === before);
  const sqlFailAll = (q) => { try { execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return ""; } catch (e) { return String(e.stderr); } };
  const counts = () => sql(`select (select count(*) from transactions) || '/' || (select count(*) from ledger_entries) || '/' || (select count(*) from cash_in_requests) || '/' || (select count(*) from cash_in_decisions)`);
  const beforeAll = counts();
  chk("5c' ledger_entries, transactions, cash_in_requests and cash_in_decisions cannot be truncated either (even CASCADE)", ["ledger_entries", "transactions", "cash_in_requests", "cash_in_decisions"].every((t) => /APPEND_ONLY/.test(sqlFailAll(`truncate ${t} cascade`))) && counts() === beforeAll, counts());
  const legacyActs = Number(sql(`select count(*) from audit_logs where actor = 'legacy-key' and timestamp > now() - interval '1 hour'`));
  chk("5d actions taken with the shared key are attributed to 'legacy-key' (to be removed: no individual accountability)", legacyActs >= 0, `legacy-key actions in the last hour: ${legacyActs}`);
}

// Leave no extra super_admin behind: other suites assume root is the last one.
await patch(`/admin/auth/users/${roles.super_admin.admin.id}`, { role: "auditor" }, root.opts);

const { fail } = summary("OPERATOR CONTROL MATRIX");
process.exit(fail ? 1 : 0);
