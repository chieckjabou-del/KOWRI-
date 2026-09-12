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

// Platform cash-in (admin only) so a test wallet has funds to work with.
export async function fund(walletId, amount, currency = "XOF") {
  const r = await post(`/wallets/${walletId}/deposit`, { amount, currency, description: "test funding" }, await adminOpts({ idempotency: true }));
  if (r.s !== 200) throw new Error(`fund failed: ${r.s} ${JSON.stringify(r.b)}`);
  return r.b;
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
