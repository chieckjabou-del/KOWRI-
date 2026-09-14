// Shared helpers for the API test suites: authenticated sessions, admin calls,
// idempotency keys and a tiny assertion counter. Requires a running server.
import { randomUUID } from "crypto";

export const BASE = process.env.API_BASE ?? "http://localhost:8080/api";
export const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "test-admin-key";
export const SEED_PIN = "1234";

let pass = 0;
let fail = 0;
const results = [];

export function chk(name, ok, detail = "") {
  const status = ok ? "✅" : "❌";
  const suffix = detail ? ` (${detail})` : "";
  console.log(`  ${status} ${name}${suffix}`);
  results.push({ name, ok, detail });
  ok ? pass++ : fail++;
  return ok;
}

export function summary(title = "RESULTS") {
  console.log(`\n${"─".repeat(60)}\n${title}: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  if (fail) {
    console.log("Failed:");
    for (const r of results.filter((r) => !r.ok)) console.log(`  - ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }
  return { pass, fail };
}

export function idem() {
  return randomUUID();
}

export async function raw(method, path, { body, token, admin, idempotency, headers } = {}) {
  const h = { "Content-Type": "application/json", ...(headers ?? {}) };
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (admin) h["X-Admin-Key"] = ADMIN_KEY;
  if (idempotency) h["Idempotency-Key"] = idempotency === true ? idem() : idempotency;
  try {
    const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const b = await r.json().catch(() => null);
    return { s: r.status, b, h: r.headers };
  } catch (e) {
    return { s: 0, b: { error: String(e) }, h: new Headers() };
  }
}

export const get   = (path, opts) => raw("GET", path, opts);
export const post  = (path, body, opts) => raw("POST", path, { ...opts, body });
export const patch = (path, body, opts) => raw("PATCH", path, { ...opts, body });
export const put   = (path, body, opts) => raw("PUT", path, { ...opts, body });
export const del   = (path, opts) => raw("DELETE", path, opts);

// A session bound to one user: every call carries that user's bearer token.
export class Session {
  constructor(user, token) {
    this.user = user;
    this.userId = user.id;
    this.token = token;
  }
  get(path, opts = {})          { return get(path, { ...opts, token: this.token }); }
  post(path, body, opts = {})   { return post(path, body, { ...opts, token: this.token }); }
  patch(path, body, opts = {})  { return patch(path, body, { ...opts, token: this.token }); }
  del(path, opts = {})          { return del(path, { ...opts, token: this.token }); }
  money(path, body, opts = {})  { return post(path, body, { ...opts, token: this.token, idempotency: opts.idempotency ?? true }); }
}

export async function login(phone, pin = SEED_PIN) {
  const r = await post("/users/login", { phone, pin });
  if (r.s !== 200 || !r.b?.token) throw new Error(`login failed for ${phone}: ${r.s} ${JSON.stringify(r.b)}`);
  return new Session(r.b.user, r.b.token);
}

let userSeq = 0;
export function uniquePhone() {
  userSeq += 1;
  return `+22507${String(Date.now() % 100000000).padStart(8, "0").slice(0, 5)}${String(userSeq).padStart(3, "0")}`;
}

// Creates a fresh user (with its auto-created personal wallet) and logs in.
export async function createUser({ firstName = "Test", lastName = "User", country = "SN", pin = SEED_PIN, kycLevel } = {}) {
  const phone = uniquePhone();
  const r = await post("/users", { phone, firstName, lastName, country, pin });
  if (r.s !== 201) throw new Error(`createUser failed: ${r.s} ${JSON.stringify(r.b)}`);
  const session = await login(phone, pin);
  if (kycLevel !== undefined) await setKycLevel(session.userId, kycLevel);
  const wallets = await session.get("/wallets");
  session.wallet = wallets.b?.wallets?.[0] ?? null;
  return session;
}

// Platform operator: a real session (seeded user 0) plus the admin key, so admin
// actions on session-gated routers are attributed to an identified actor.
let operatorSession = null;
export async function operator() {
  operatorSession ??= await login(OPERATOR_PHONE);
  return operatorSession;
}
export async function adminOpts(extra = {}) {
  const op = await operator();
  return { ...extra, token: op.token, admin: true };
}

// Test-only shortcut through the compliance workflow: submit + approve a KYC record.
export async function setKycLevel(userId, kycLevel) {
  const admin = await adminOpts();
  const submit = await post(`/users/${userId}/kyc`, {
    kycLevel, documentType: "national_id", documentNumber: `DOC-${randomUUID().slice(0, 8)}`,
    fullName: "Test User", dateOfBirth: "1990-01-01",
  }, admin);
  if (submit.s !== 201) throw new Error(`kyc submit failed: ${submit.s} ${JSON.stringify(submit.b)}`);
  const review = await patch(`/compliance/kyc/${submit.b.record.id}`, { decision: "approve" }, admin);
  if (review.s !== 200) throw new Error(`kyc approve failed: ${review.s} ${JSON.stringify(review.b)}`);
  return review.b;
}

// ── Named operator accounts ──────────────────────────────────────────────────
// Money creation needs two distinct named operators (maker-checker), so the
// suites keep a fixed set of accounts: a super_admin (bootstrapped with the
// legacy key on an empty install), an `operations` maker and a `compliance`
// checker. Passwords are test fixtures for a local/CI database only.
export const ROOT_ADMIN = { email: "root@kowri.test", name: "Root", password: "RootPassw0rd-2026" };
export const MAKER_ADMIN = { email: "cashin-maker@kowri.test", name: "Cash-in maker", password: "MakerPassw0rd-2026", role: "operations" };
export const CHECKER_ADMIN = { email: "cashin-checker@kowri.test", name: "Cash-in checker", password: "CheckerPassw0rd-2026", role: "compliance" };
export const asAdminToken = (token, extra = {}) => ({ ...extra, headers: { ...(extra.headers ?? {}), "X-Admin-Token": token } });

export async function adminLogin(account) {
  const r = await post("/admin/auth/login", { email: account.email, password: account.password });
  if (r.s !== 200 || !r.b?.token) throw new Error(`admin login failed for ${account.email}: ${r.s} ${JSON.stringify(r.b)}`);
  return { token: r.b.token, admin: r.b.admin, opts: asAdminToken(r.b.token) };
}

// Creates (once) and logs in an admin account through the admins.manage API.
export async function ensureAdmin(account, rootToken) {
  const created = await post("/admin/auth/users", { email: account.email, name: account.name, password: account.password, role: account.role }, asAdminToken(rootToken));
  if (created.s !== 201 && created.s !== 409) throw new Error(`ensureAdmin ${account.email} failed: ${created.s} ${JSON.stringify(created.b)}`);
  return adminLogin(account);
}

let operatorsCache = null;
export async function operators() {
  if (operatorsCache) return operatorsCache;
  const boot = await post("/admin/auth/bootstrap", ROOT_ADMIN, { admin: true });
  if (boot.s !== 201 && boot.s !== 409) throw new Error(`bootstrap failed: ${boot.s} ${JSON.stringify(boot.b)}`);
  const root = await adminLogin(ROOT_ADMIN);
  const maker = await ensureAdmin(MAKER_ADMIN, root.token);
  const checker = await ensureAdmin(CHECKER_ADMIN, root.token);
  operatorsCache = { root, maker, checker };
  return operatorsCache;
}

// Platform cash-in through the maker-checker: the maker initiates, the checker
// approves, and the super_admin signs second when the amount needs it. This is
// the only way a test wallet gets money that was not transferred to it.
// When one maker reaches their daily ceiling, the suites move on to another
// named operations account, as a real back-office would.
let makerSeq = 1;
export async function fund(walletId, amount, currency = "XOF", { source = "test_funding", reference } = {}) {
  const ops = await operators();
  const { root, checker } = ops;
  let init;
  for (let attempt = 0; attempt < 6; attempt++) {
    init = await post("/admin/cash-in", {
      walletId, amount, currency, source, reference: reference ?? `TEST-${randomUUID()}`, description: "test funding",
    }, asAdminToken(ops.maker.token, { idempotency: true }));
    if (init.s === 409 && init.b?.code === "CASH_IN_LIMIT_OPERATOR") {
      makerSeq += 1;
      ops.maker = await ensureAdmin({ ...MAKER_ADMIN, email: `cashin-maker-${makerSeq}@kowri.test`, name: `Cash-in maker ${makerSeq}` }, root.token);
      continue;
    }
    break;
  }
  if (init.s !== 201) throw new Error(`fund: initiate failed: ${init.s} ${JSON.stringify(init.b)}`);
  const id = init.b.request.id;
  let approve = await post(`/admin/cash-in/${id}/approve`, {}, asAdminToken(checker.token));
  if (approve.s !== 200) throw new Error(`fund: approve failed: ${approve.s} ${JSON.stringify(approve.b)}`);
  if (approve.b.request.status === "APPROVED") {
    approve = await post(`/admin/cash-in/${id}/approve`, {}, asAdminToken(root.token));
    if (approve.s !== 200) throw new Error(`fund: second approval failed: ${approve.s} ${JSON.stringify(approve.b)}`);
  }
  if (approve.b.request.status !== "EXECUTED") throw new Error(`fund: request ended ${approve.b.request.status}`);
  return approve.b.transaction;
}

export async function balance(session, walletId) {
  const r = await session.get(`/wallets/${walletId}`);
  return Number(r.b?.balance ?? NaN);
}

export function seededPhone(i) {
  return `+2250${700000000 + i}`;
}

// Seeded user 1: active, KYC level 2, XOF personal wallet (user 0's wallet is XAF).
export const OPERATOR_PHONE = seededPhone(1);
