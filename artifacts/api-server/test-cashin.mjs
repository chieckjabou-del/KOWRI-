// ── Cash-in maker-checker: adversarial suite ─────────────────────────────────
// Every attack the P0 financial control gate demands, run against a live
// server and its database. Each check is a refusal the platform must produce
// (HTTP code + error code, or a PostgreSQL exception) or an invariant that
// must hold afterwards (balance credited once, request in the right state,
// ledger equal to EXECUTED requests). Requires psql on PATH and the API on
// :8080 (DATABASE_URL defaults to the local development database).

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  get, post, patch, del, put, chk, summary, createUser, balance, fund, operators, ensureAdmin, adminLogin, asAdminToken,
  ROOT_ADMIN, ADMIN_KEY, idem,
} from "./test-lib.mjs";

const DB = process.env.DATABASE_URL ?? "postgres://kowri:kowri@localhost:5432/kowri";
function sql(query) { return execFileSync("psql", [DB, "-Atc", query], { encoding: "utf8" }).trim(); }
function sqlFail(query) {
  try { execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return ""; }
  catch (e) { return String(e.stderr).split("\n")[0]; }
}
const codes = (rs) => rs.map((r) => `${r.s}${r.b?.code ? ":" + r.b.code : ""}`).join(",");
const RUN = randomUUID().slice(0, 8);

const { root, checker } = await operators();
// A maker of its own for this run: the shared maker may already be at its
// daily ceiling after the other suites (the ceiling is per initiator).
const maker = await ensureAdmin({ email: `cashin-maker-${RUN}@kowri.test`, name: "Cash-in maker (run)", password: "MakerRunPassw0rd-2026", role: "operations" }, root.token);
const limits = (await get("/admin/cash-in/limits", root.opts)).b.limits;
const MAX = limits.maxPerOperation, THRESHOLD = limits.secondApprovalThreshold;
console.log(`limits: ${JSON.stringify(limits)}`);

async function initiate(walletId, amount, extra = {}, who = maker) {
  return post("/admin/cash-in", { walletId, amount, currency: "XOF", source: "bank_transfer", reference: `REF-${RUN}-${randomUUID().slice(0, 8)}`, ...extra }, asAdminToken(who.token, { idempotency: extra.idempotency ?? true }));
}
const approve = (id, who, body = {}) => post(`/admin/cash-in/${id}/approve`, body, asAdminToken(who.token));
const txCount = (id) => Number(sql(`select count(*) from transactions where idempotency_key = 'cash-in:${id}'`));
const status = (id) => sql(`select status from cash_in_requests where id = '${id}'`);

// Extra named operators for the matrix: one more approver, and the weak roles.
const checker2 = await ensureAdmin({ email: "cashin-checker-2@kowri.test", name: "Second checker", password: "Checker2Passw0rd-2026", role: "compliance" }, root.token);
const support  = await ensureAdmin({ email: "cashin-support@kowri.test", name: "Support", password: "SupportPassw0rd-2026", role: "support" }, root.token);
const auditor  = await ensureAdmin({ email: "cashin-auditor@kowri.test", name: "Auditor", password: "AuditorPassw0rd-2026", role: "auditor" }, root.token);

// ── A1. Identity and privilege ───────────────────────────────────────────────
console.log("\nA1. Identity and privilege");
{
  const u = await createUser({ kycLevel: 2 });
  const noAuth = await post("/admin/cash-in", { walletId: u.wallet.id, amount: 1000, currency: "XOF", source: "other", reference: "x" }, { idempotency: true });
  chk("A1a initiate without any credential → 403", noAuth.s === 403, `status=${noAuth.s}`);
  const asUser = await u.money("/admin/cash-in", { walletId: u.wallet.id, amount: 1000, currency: "XOF", source: "other", reference: `USR-${RUN}` });
  chk("A1b a product user cannot initiate a cash-in to their own wallet → 403", asUser.s === 403, `status=${asUser.s}`);
  const legacy = await post("/admin/cash-in", { walletId: u.wallet.id, amount: 1000, currency: "XOF", source: "other", reference: `LEG-${RUN}` }, { admin: true, idempotency: true });
  chk("A1c the shared legacy key cannot initiate → 403 SESSION_REQUIRED", legacy.s === 403 && legacy.b?.code === "SESSION_REQUIRED", `status=${legacy.s} ${legacy.b?.code}`);
  const bySupport = await initiate(u.wallet.id, 1000, {}, support);
  chk("A1d support (no ledger.write) cannot initiate → 403 PERMISSION_DENIED", bySupport.s === 403 && bySupport.b?.code === "PERMISSION_DENIED" && bySupport.b?.required === "ledger.write", codes([bySupport]));
  const byAuditor = await initiate(u.wallet.id, 1000, {}, auditor);
  chk("A1e auditor cannot initiate → 403", byAuditor.s === 403, codes([byAuditor]));
  const byChecker = await initiate(u.wallet.id, 1000, {}, checker);
  chk("A1f compliance (approver) cannot initiate → 403 ledger.write", byChecker.s === 403 && byChecker.b?.required === "ledger.write", codes([byChecker]));

  const req = await initiate(u.wallet.id, 1000);
  chk("A1g operations initiates → 201 PENDING_APPROVAL", req.s === 201 && req.b?.request?.status === "PENDING_APPROVAL", `status=${req.s} ${JSON.stringify(req.b).slice(0, 120)}`);
  const id = req.b.request.id;
  chk("A1h nothing credited at initiation", (await balance(u, u.wallet.id)) === 0 && txCount(id) === 0);
  const legacyApprove = await post(`/admin/cash-in/${id}/approve`, {}, { admin: true });
  chk("A1i legacy key cannot approve → 403 SESSION_REQUIRED", legacyApprove.s === 403 && legacyApprove.b?.code === "SESSION_REQUIRED", codes([legacyApprove]));
  const userApprove = await u.post(`/admin/cash-in/${id}/approve`, {});
  chk("A1j product user cannot approve → 403", userApprove.s === 403, codes([userApprove]));
  const makerApprove = await approve(id, maker);
  chk("A1k the initiator cannot approve their own request → 403 (ledger.approve or self)", makerApprove.s === 403, codes([makerApprove]));
  const supportApprove = await approve(id, support);
  chk("A1l support cannot approve → 403", supportApprove.s === 403, codes([supportApprove]));
  const anon = await post(`/admin/cash-in/${id}/approve`, {});
  chk("A1m approve without credential → 403", anon.s === 403, codes([anon]));
  chk("A1n request still PENDING_APPROVAL, wallet still empty", status(id) === "PENDING_APPROVAL" && (await balance(u, u.wallet.id)) === 0);

  const ok = await approve(id, checker, { reason: "bank slip verified" });
  chk("A1o a distinct compliance operator approves → 200 EXECUTED with a transaction", ok.s === 200 && ok.b?.request?.status === "EXECUTED" && !!ok.b?.transaction?.id, codes([ok]));
  chk("A1p wallet credited exactly once", (await balance(u, u.wallet.id)) === 1000 && txCount(id) === 1);
  const detail = await get(`/admin/cash-in/${id}`, auditor.opts);
  chk("A1q auditor reads the full trail (initiate + approve, two distinct operators)", detail.s === 200 && detail.b?.request?.decisions?.length === 2 && new Set(detail.b.request.decisions.map((d) => d.adminId)).size === 2, `decisions=${JSON.stringify(detail.b?.request?.decisions?.map((d) => d.decision))}`);
  const trail = sql(`select string_agg(action || ':' || actor, ',' order by timestamp) from audit_logs where entity = 'cash_in_request' and entity_id = '${id}'`);
  chk("A1r audit_logs carry initiator and approver by name", trail.includes(`cash_in.initiated:${maker.admin.email}`) && trail.includes(`cash_in.executed:${checker.admin.email}`), trail);
}

// ── A2. Self-approval at the database level ──────────────────────────────────
console.log("\nA2. Segregation of duties enforced by the database");
{
  const u = await createUser({ kycLevel: 2 });
  const id = (await initiate(u.wallet.id, 1000)).b.request.id;
  const e1 = sqlFail(`update cash_in_requests set status = 'APPROVED', approved_by = initiated_by, approved_at = now() where id = '${id}'`);
  chk("A2a SQL: approved_by = initiated_by is refused (CASH_IN_SELF_APPROVAL)", /CASH_IN_SELF_APPROVAL/.test(e1), e1);
  const e2 = sqlFail(`update cash_in_requests set status = 'EXECUTED', approved_by = '${checker.admin.id}', approved_at = now(), transaction_id = 'ghost-${RUN}', executed_at = now() where id = '${id}'`);
  chk("A2b SQL: EXECUTED pointing at a transaction that does not exist is refused", /CASH_IN_EXECUTED_WITHOUT_TRANSACTION/.test(e2), e2);
  const e3 = sqlFail(`update cash_in_requests set status = 'EXECUTED', approved_by = '${checker.admin.id}', approved_at = now() where id = '${id}'`);
  chk("A2c SQL: EXECUTED without a transaction is refused", /CASH_IN_EXECUTED_WITHOUT/.test(e3), e3);
  const e4 = sqlFail(`update cash_in_requests set amount = amount * 10 where id = '${id}'`);
  chk("A2d SQL: the amount of a pending request cannot change (CASH_IN_IMMUTABLE)", /CASH_IN_IMMUTABLE/.test(e4), e4);
  const e5 = sqlFail(`update cash_in_requests set wallet_id = 'someone-else' where id = '${id}'`);
  chk("A2e SQL: the beneficiary wallet cannot change", /CASH_IN_IMMUTABLE/.test(e5), e5);
  const e6 = sqlFail(`update cash_in_requests set expires_at = now() + interval '30 days' where id = '${id}'`);
  chk("A2f SQL: the expiry cannot be pushed back", /CASH_IN_IMMUTABLE/.test(e6), e6);
  const e7 = sqlFail(`delete from cash_in_requests where id = '${id}'`);
  chk("A2g SQL: a request is never deleted", /never deleted/.test(e7), e7);
  const e8 = sqlFail(`insert into cash_in_requests (id, wallet_id, user_id, amount, currency, amount_reference, reference, source, status, approvals_required, initiated_by, initiated_by_email, expires_at, approved_by, transaction_id, executed_at) values ('forged-${RUN}', '${u.wallet.id}', '${u.userId}', 5000, 'XOF', 5000, 'FORGED-${RUN}', 'other', 'EXECUTED', 1, '${maker.admin.id}', 'x', now() + interval '1 day', '${checker.admin.id}', 'ghost', now())`);
  chk("A2h SQL: a request cannot be born already EXECUTED", /CASH_IN_INVALID_INSERT/.test(e8), e8);
  const e9 = sqlFail(`insert into cash_in_requests (id, wallet_id, user_id, amount, currency, amount_reference, reference, source, approvals_required, initiated_by, initiated_by_email, expires_at) values ('legacy-${RUN}', '${u.wallet.id}', '${u.userId}', 5000, 'XOF', 5000, 'LEGACY-${RUN}', 'other', 1, 'legacy-key', 'legacy-key@local', now() + interval '1 day')`);
  chk("A2i SQL: the shared key cannot be an initiator even by direct insert", /CASH_IN_INVALID_INSERT/.test(e9), e9);
  // API: two-signature request approved once by C1 then again by C1 → refused; by R → executed.
  const big = await initiate(u.wallet.id, THRESHOLD);
  chk("A2j amount at the threshold needs two signatures", big.s === 201 && big.b.request.approvalsRequired === 2, `approvals=${big.b?.request?.approvalsRequired}`);
  const first = await approve(big.b.request.id, checker);
  chk("A2k first signature → APPROVED, no money yet", first.s === 200 && first.b.request.status === "APPROVED" && first.b.transaction === null && (await balance(u, u.wallet.id)) === 0, codes([first]));
  const again = await approve(big.b.request.id, checker);
  chk("A2l the same approver cannot sign twice → 403 CASH_IN_SELF_APPROVAL", again.s === 403 && again.b?.code === "CASH_IN_SELF_APPROVAL", codes([again]));
  const byMaker = await approve(big.b.request.id, maker);
  chk("A2m the initiator cannot be the second signature → 403", byMaker.s === 403, codes([byMaker]));
  const e10 = sqlFail(`update cash_in_requests set second_approved_by = approved_by where id = '${big.b.request.id}'`);
  chk("A2n SQL: second_approved_by = approved_by is refused", /CASH_IN_SELF_APPROVAL/.test(e10), e10);
  const second = await approve(big.b.request.id, root);
  chk("A2o a third distinct operator signs → EXECUTED, credited once", second.s === 200 && second.b.request.status === "EXECUTED" && (await balance(u, u.wallet.id)) === THRESHOLD && txCount(big.b.request.id) === 1, codes([second]));
  const e11 = sqlFail(`update cash_in_requests set close_reason = 'x' where id = '${big.b.request.id}'`);
  chk("A2p SQL: an EXECUTED request never changes again (CASH_IN_CLOSED)", /CASH_IN_CLOSED/.test(e11), e11);
}

// ── A3. Concurrency ──────────────────────────────────────────────────────────
console.log("\nA3. Concurrent approvals and executions");
{
  const u = await createUser({ kycLevel: 2 });
  const id = (await initiate(u.wallet.id, 2000)).b.request.id;
  const race = await Promise.all([approve(id, checker), approve(id, checker2), approve(id, root), approve(id, checker), approve(id, root)]);
  const executed = race.filter((r) => r.s === 200 && r.b?.request?.status === "EXECUTED");
  chk("A3a five simultaneous approvals by three approvers → exactly one executes", executed.length === 1, codes(race));
  chk("A3b the others are refused 409 (already executed / already processed)", race.filter((r) => r.s !== 200).every((r) => r.s === 409), codes(race));
  chk("A3c wallet credited exactly once", (await balance(u, u.wallet.id)) === 2000 && txCount(id) === 1);

  // Two-signature request: first signature, then a burst of second signatures.
  const big = await initiate(u.wallet.id, THRESHOLD);
  await approve(big.b.request.id, checker);
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => approve(big.b.request.id, i % 2 ? root : checker2)));
  const done = burst.filter((r) => r.s === 200 && r.b?.request?.status === "EXECUTED");
  chk("A3d ten simultaneous second signatures → exactly one execution", done.length === 1, codes(burst));
  chk("A3e credited exactly once", (await balance(u, u.wallet.id)) === 2000 + THRESHOLD && txCount(big.b.request.id) === 1);

  // Twenty parallel single-signature requests on one wallet, all approved in parallel.
  const v = await createUser({ kycLevel: 2 });
  const reqs = await Promise.all(Array.from({ length: 20 }, () => initiate(v.wallet.id, 100)));
  chk("A3f twenty parallel initiations all accepted", reqs.every((r) => r.s === 201), codes(reqs.filter((r) => r.s !== 201)));
  const apps = await Promise.all(reqs.map((r, i) => approve(r.b.request.id, i % 2 ? checker : checker2)));
  chk("A3g twenty parallel approvals all execute", apps.every((r) => r.s === 200 && r.b.request.status === "EXECUTED"), codes(apps.filter((r) => r.s !== 200)));
  chk("A3h wallet holds exactly 20 × 100", (await balance(v, v.wallet.id)) === 2000);

  // Retry after success and double retry: never re-applied.
  const retry = await approve(id, checker2);
  const retry2 = await approve(id, root);
  chk("A3i retrying an executed approval → 409, and again → 409", retry.s === 409 && retry2.s === 409, codes([retry, retry2]));
  chk("A3j still credited once", (await balance(u, u.wallet.id)) === 2000 + THRESHOLD);
}

// ── A4. References and idempotency ───────────────────────────────────────────
console.log("\nA4. References and idempotency");
{
  const u = await createUser({ kycLevel: 2 });
  const ref = `SLIP-${RUN}`;
  const a = await initiate(u.wallet.id, 3000, { reference: ref });
  const b = await initiate(u.wallet.id, 3000, { reference: ref });
  chk("A4a the same external reference cannot be filed twice → 409 CASH_IN_DUPLICATE_REFERENCE", a.s === 201 && b.s === 409 && b.b?.code === "CASH_IN_DUPLICATE_REFERENCE", codes([a, b]));
  const b2 = await initiate(u.wallet.id, 3000, { reference: ` ${ref.toLowerCase()}  ` });
  chk("A4a' the same reference with different casing or spacing is still a duplicate", b2.s === 409 && b2.b?.code === "CASH_IN_DUPLICATE_REFERENCE", codes([b2]));
  const c = await initiate(u.wallet.id, 3000);
  chk("A4b same wallet+amount under another reference is accepted but flagged SIMILAR_REQUEST for the approver", c.s === 201 && c.b.request.warnings.some((w) => w.startsWith(`SIMILAR_REQUEST:${a.b.request.id}`)), JSON.stringify(c.b?.request?.warnings));
  const key = idem();
  const body = { walletId: u.wallet.id, amount: 4000, currency: "XOF", source: "agent_cash", reference: `IDEM-${RUN}` };
  const k1 = await post("/admin/cash-in", body, asAdminToken(maker.token, { idempotency: key }));
  const k2 = await post("/admin/cash-in", body, asAdminToken(maker.token, { idempotency: key }));
  chk("A4c same idempotency key + same body → replayed, one request", k1.s === 201 && k2.s === 201 && k1.b.request.id === k2.b.request.id && k2.h.get("x-idempotent-replayed") === "true", codes([k1, k2]));
  const k3 = await post("/admin/cash-in", { ...body, amount: 4_000_000 }, asAdminToken(maker.token, { idempotency: key }));
  chk("A4d same key, different amount → 422 IDEMPOTENCY_PAYLOAD_MISMATCH", k3.s === 422 && k3.b?.code === "IDEMPOTENCY_PAYLOAD_MISMATCH", codes([k3]));
  const k4 = await post("/admin/cash-in", { ...body, walletId: (await createUser()).wallet.id }, asAdminToken(maker.token, { idempotency: key }));
  chk("A4e same key, different beneficiary → 422", k4.s === 422, codes([k4]));
  const burst = await Promise.all(Array.from({ length: 5 }, () => post("/admin/cash-in", { ...body, reference: `IDEM2-${RUN}` }, asAdminToken(maker.token, { idempotency: `${key}-b` }))));
  chk("A4f five parallel initiations with one key → one request", new Set(burst.filter((r) => r.s === 201).map((r) => r.b.request.id)).size === 1 && burst.every((r) => r.s === 201 || r.s === 409), codes(burst));
  chk("A4g exactly one request row carries that reference (stored normalised, upper-case)", sql(`select count(*) from cash_in_requests where reference = upper('IDEM2-${RUN}')`) === "1");
  const noKey = await post("/admin/cash-in", body, asAdminToken(maker.token));
  chk("A4h initiation without Idempotency-Key → 400", noKey.s === 400, codes([noKey]));
}

// ── A5. Lifecycle: reject, cancel, expiry ────────────────────────────────────
console.log("\nA5. Reject, cancel, expiry");
{
  const u = await createUser({ kycLevel: 2 });
  const r1 = (await initiate(u.wallet.id, 5000)).b.request.id;
  const noReason = await post(`/admin/cash-in/${r1}/reject`, {}, checker.opts);
  chk("A5a rejection needs a reason → 400", noReason.s === 400, codes([noReason]));
  const byMaker = await post(`/admin/cash-in/${r1}/reject`, { reason: "oops" }, maker.opts);
  chk("A5b the maker cannot reject (needs ledger.approve) → 403", byMaker.s === 403, codes([byMaker]));
  const rej = await post(`/admin/cash-in/${r1}/reject`, { reason: "slip does not match" }, checker.opts);
  chk("A5c compliance rejects → REJECTED", rej.s === 200 && rej.b.request.status === "REJECTED" && rej.b.request.closedBy === checker.admin.id, codes([rej]));
  const afterRej = await approve(r1, checker2);
  chk("A5d execute after reject → 409 CASH_IN_ALREADY_REJECTED", afterRej.s === 409 && afterRej.b?.code === "CASH_IN_ALREADY_REJECTED", codes([afterRej]));
  const e1 = sqlFail(`update cash_in_requests set status = 'PENDING_APPROVAL', closed_by = null, closed_at = null where id = '${r1}'`);
  chk("A5e SQL: a rejected request cannot be reopened", /CASH_IN_CLOSED/.test(e1), e1);

  const r2 = (await initiate(u.wallet.id, 5000)).b.request.id;
  const cancelBySupport = await post(`/admin/cash-in/${r2}/cancel`, { reason: "x" }, support.opts);
  chk("A5f support cannot cancel → 403", cancelBySupport.s === 403, codes([cancelBySupport]));
  const cancelByLegacy = await post(`/admin/cash-in/${r2}/cancel`, { reason: "x" }, { admin: true });
  chk("A5g legacy key cannot cancel → 403 SESSION_REQUIRED", cancelByLegacy.s === 403 && cancelByLegacy.b?.code === "SESSION_REQUIRED", codes([cancelByLegacy]));
  const cancel = await post(`/admin/cash-in/${r2}/cancel`, { reason: "filed by mistake" }, maker.opts);
  chk("A5h the initiator cancels their own request → CANCELLED", cancel.s === 200 && cancel.b.request.status === "CANCELLED", codes([cancel]));
  const afterCancel = await approve(r2, checker);
  chk("A5i execute after cancel → 409 CASH_IN_ALREADY_CANCELLED", afterCancel.s === 409 && afterCancel.b?.code === "CASH_IN_ALREADY_CANCELLED", codes([afterCancel]));
  const r3 = (await initiate(u.wallet.id, 5000)).b.request.id;
  const other = await ensureAdmin({ email: "cashin-maker-b@kowri.test", name: "Other maker", password: "MakerBPassw0rd-2026", role: "operations" }, root.token);
  const cancelByOther = await post(`/admin/cash-in/${r3}/cancel`, { reason: "x" }, other.opts);
  chk("A5j another maker cannot cancel someone else's request → 403", cancelByOther.s === 403, codes([cancelByOther]));
  const cancelByChecker = await post(`/admin/cash-in/${r3}/cancel`, { reason: "withdrawn by compliance" }, checker.opts);
  chk("A5k an approver may cancel → CANCELLED", cancelByChecker.s === 200 && cancelByChecker.b.request.status === "CANCELLED", codes([cancelByChecker]));

  // Expiry: a request born two days ago (direct insert, as a crashed old instance could leave it).
  const expired = `cin_exp-${RUN}`;
  sql(`insert into cash_in_requests (id, wallet_id, user_id, amount, currency, amount_reference, reference, source, approvals_required, initiated_by, initiated_by_email, initiated_at, expires_at) values ('${expired}', '${u.wallet.id}', '${u.userId}', 7000, 'XOF', 7000, 'OLD-${RUN}', 'other', 1, '${maker.admin.id}', '${maker.admin.email}', now() - interval '2 days', now() - interval '1 day')`);
  const late = await approve(expired, checker);
  chk("A5l execute after expiry → 409 CASH_IN_EXPIRED, nothing credited", late.s === 409 && late.b?.code === "CASH_IN_EXPIRED" && txCount(expired) === 0, codes([late]));
  const e2 = sqlFail(`update cash_in_requests set status = 'EXECUTED', approved_by = '${checker.admin.id}', approved_at = now(), transaction_id = 'ghost', executed_at = now() where id = '${expired}'`);
  chk("A5m SQL: forcing an expired request to EXECUTED is refused", /CASH_IN_EXPIRED|CASH_IN_EXECUTED_WITHOUT_TRANSACTION/.test(e2), e2);
  const sweep = await post("/admin/cash-in/expire", {}, checker.opts);
  chk("A5n the expiry sweep closes it (EXPIRED)", sweep.s === 200 && sweep.b.expired >= 1 && status(expired) === "EXPIRED", `expired=${sweep.b?.expired} status=${status(expired)}`);
  const afterExpire = await approve(expired, checker);
  chk("A5o execute after EXPIRED → 409", afterExpire.s === 409 && afterExpire.b?.code === "CASH_IN_ALREADY_EXPIRED", codes([afterExpire]));
  chk("A5p wallet balance unchanged by the whole section", (await balance(u, u.wallet.id)) === 0);
}

// ── A6. Limits ───────────────────────────────────────────────────────────────
console.log("\nA6. Limits");
{
  // A fresh maker so this section measures the beneficiary ceiling, not what the shared maker already filed today.
  const limMaker = await ensureAdmin({ email: `cashin-maker-lim-${RUN}@kowri.test`, name: "Limits maker", password: "MakerLimPassw0rd-2026", role: "operations" }, root.token);
  const initiate = (walletId, amount, extra = {}) => post("/admin/cash-in", { walletId, amount, currency: "XOF", source: "bank_transfer", reference: `LIM-${RUN}-${randomUUID().slice(0, 8)}`, ...extra }, asAdminToken(limMaker.token, { idempotency: true }));
  const u = await createUser({ kycLevel: 2 });
  const over = await initiate(u.wallet.id, MAX + 1);
  chk("A6a above the per-operation limit → 409 CASH_IN_LIMIT_OPERATION", over.s === 409 && over.b?.code === "CASH_IN_LIMIT_OPERATION", codes([over]));
  const huge = await initiate(u.wallet.id, 1e17);
  chk("A6b absurd amount → refused (409 limit or 400 amount)", huge.s === 409 || huge.s === 400, codes([huge]));
  const neg = await initiate(u.wallet.id, -5);
  const zero = await initiate(u.wallet.id, 0);
  const str = await initiate(u.wallet.id, "1000");
  chk("A6c negative, zero and string amounts → 400", neg.s === 400 && zero.s === 400 && str.s === 400, codes([neg, zero, str]));
  const under = await initiate(u.wallet.id, THRESHOLD - 1);
  chk("A6d just under the threshold needs one signature", under.s === 201 && under.b.request.approvalsRequired === 1);
  await post(`/admin/cash-in/${under.b.request.id}/cancel`, { reason: "limit test" }, limMaker.opts);

  // Daily ceiling per beneficiary, with concurrency: N parallel requests that
  // together exceed the ceiling must be cut at the ceiling, not each accepted.
  const cap = limits.dailyPerBeneficiary;
  const chunk = Math.min(MAX, cap / 4);
  const parallel = await Promise.all(Array.from({ length: 6 }, () => initiate(u.wallet.id, chunk)));
  const accepted = parallel.filter((r) => r.s === 201);
  const refused = parallel.filter((r) => r.s === 409 && r.b?.code === "CASH_IN_LIMIT_BENEFICIARY");
  chk("A6e six parallel requests of cap/4 → exactly four accepted, two refused CASH_IN_LIMIT_BENEFICIARY", accepted.length === 4 && refused.length === 2, codes(parallel));
  const one = await initiate(u.wallet.id, 1);
  chk("A6f then even 1 XOF more is refused", one.s === 409 && one.b?.code === "CASH_IN_LIMIT_BENEFICIARY", codes([one]));
  for (const r of accepted) await post(`/admin/cash-in/${r.b.request.id}/cancel`, { reason: "limit test" }, limMaker.opts);
  const freed = await initiate(u.wallet.id, 1);
  chk("A6g cancelled requests no longer count against the ceiling", freed.s === 201, codes([freed]));
  await post(`/admin/cash-in/${freed.b.request.id}/cancel`, { reason: "limit test" }, limMaker.opts);
  const lim = await get("/admin/cash-in/limits", auditor.opts);
  chk("A6h limits are published to every operator role", lim.s === 200 && lim.b.limits.dailyPerInitiator > 0 && lim.b.limits.dailyPlatform > 0);
}

// ── A7. Beneficiary wallet checks ────────────────────────────────────────────
console.log("\nA7. Beneficiary");
{
  const ghost = await initiate("no-such-wallet", 1000);
  chk("A7a unknown wallet → 404", ghost.s === 404 && ghost.b?.code === "WALLET_NOT_FOUND", codes([ghost]));
  const u = await createUser({ kycLevel: 2 });
  const wrongCur = await initiate(u.wallet.id, 1000, { currency: "EUR" });
  chk("A7b currency ≠ wallet currency → 400", wrongCur.s === 400 && wrongCur.b?.code === "CURRENCY_MISMATCH", codes([wrongCur]));
  await patch(`/admin/wallets/${u.wallet.id}/status`, { status: "frozen", reason: "test" }, root.opts);
  const frozen = await initiate(u.wallet.id, 1000);
  chk("A7c frozen wallet → 409 WALLET_NOT_ACTIVE", frozen.s === 409 && frozen.b?.code === "WALLET_NOT_ACTIVE", codes([frozen]));
  await patch(`/admin/wallets/${u.wallet.id}/status`, { status: "active" }, root.opts);
  // Approval while the platform kill switch is fired: the deposit is refused
  // mid-flight, the request stays open, nothing is written, and the same
  // approval retried afterwards executes exactly once.
  const id = (await initiate(u.wallet.id, 1000)).b.request.id;
  await post("/admin/kill-switches/all/fire", { reason: "cash-in attack test" }, root.opts);
  const onHold = await approve(id, checker);
  await post("/admin/kill-switches/all/lift", {}, root.opts);
  chk("A7d approval under a fired kill switch → 503, request still PENDING, no transaction", onHold.s === 503 && status(id) === "PENDING_APPROVAL" && txCount(id) === 0, `${codes([onHold])} status=${status(id)}`);
  chk("A7e no approval decision was recorded for the failed attempt", sql(`select count(*) from cash_in_decisions where request_id = '${id}' and decision = 'approve'`) === "0");
  const retry = await approve(id, checker);
  chk("A7f the same approval retried after the switch is lifted executes once", retry.s === 200 && retry.b.request.status === "EXECUTED" && (await balance(u, u.wallet.id)) === 1000, codes([retry]));
  const susp = await createUser({ kycLevel: 2 });
  sql(`update users set status = 'suspended' where id = '${susp.userId}'`);
  const toSuspended = await initiate(susp.wallet.id, 1000);
  chk("A7g suspended owner → 409 USER_SUSPENDED", toSuspended.s === 409 && toSuspended.b?.code === "USER_SUSPENDED", codes([toSuspended]));
  const treasury = (await get("/admin/treasury", root.opts)).b?.wallets?.find((w) => w.currency === "XOF");
  const cap = await initiate(treasury?.id ?? "none", 1000);
  chk("A7h treasury capital goes through the same maker-checker", cap.s === 201, codes([cap]));
  await post(`/admin/cash-in/${cap.b?.request?.id}/cancel`, { reason: "test" }, maker.opts);
}

// ── A8. Money without a source — every alternative route ─────────────────────
console.log("\nA8. Alternative routes to create money");
{
  const u = await createUser({ kycLevel: 2 });
  const w = u.wallet.id;
  const legacyDeposit = await post(`/wallets/${w}/deposit`, { amount: 1000, currency: "XOF" }, { admin: true, idempotency: true });
  chk("A8a the old direct deposit route is retired → 410", legacyDeposit.s === 410 && legacyDeposit.b?.code === "CASH_IN_MAKER_CHECKER_REQUIRED", codes([legacyDeposit]));
  const rootDeposit = await post(`/wallets/${w}/deposit`, { amount: 1000, currency: "XOF" }, asAdminToken(root.token, { idempotency: true }));
  chk("A8b even a super_admin session gets 410", rootDeposit.s === 410, codes([rootDeposit]));
  const anonDeposit = await post(`/wallets/${w}/deposit`, { amount: 1000, currency: "XOF" }, { idempotency: true });
  chk("A8c and without credential 401/403 (never a hint of success)", anonDeposit.s === 401 || anonDeposit.s === 403, codes([anonDeposit]));

  // Creator earnings used to mint money into the creator's wallet.
  const creator = await createUser({ kycLevel: 2 });
  const comm = await creator.post("/creator/communities", { name: `Mint ${RUN}`, creatorId: creator.userId, handle: `mint-${RUN}`, platformFeeRate: 2, creatorFeeRate: 5 });
  const before = await balance(creator, creator.wallet.id);
  const earn = await creator.post(`/creator/communities/${comm.b?.id}/earnings`, { transactionAmount: 10_000_000, currency: "XOF" });
  chk("A8d declaring creator earnings credits nothing (credited:false)", earn.s === 200 && earn.b?.credited === false && (await balance(creator, creator.wallet.id)) === before, `${codes([earn])} credited=${earn.b?.credited}`);
  const byStranger = await u.post(`/creator/communities/${comm.b?.id}/earnings`, { transactionAmount: 10_000_000, currency: "XOF" });
  chk("A8e a stranger cannot declare another creator's earnings → 403", byStranger.s === 403, codes([byStranger]));

  // Direct SQL: a deposit without authority, a float debit under a transfer, a
  // deposit claiming a request that is not executed, a fake request id.
  const e1 = sqlFail(`begin; insert into transactions (id, to_wallet_id, amount, currency, type, status, reference) values ('sql-dep-${RUN}', '${w}', 1000, 'XOF', 'deposit', 'completed', 'SQL-DEP-${RUN}'); insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('sql-e1-${RUN}', 'sql-dep-${RUN}', 'platform_float', 'platform', 1000, 0, 'XOF', 'deposit'), ('sql-e2-${RUN}', 'sql-dep-${RUN}', '${w}', 'wallet', 0, 1000, 'XOF', 'deposit'); commit;`);
  chk("A8f SQL: a balanced deposit with no authority is refused at COMMIT", /DEPOSIT_WITHOUT_AUTHORITY|FLOAT_DEBIT_WITHOUT_AUTHORITY/.test(e1), e1);
  const e2 = sqlFail(`begin; insert into transactions (id, to_wallet_id, amount, currency, type, status, reference) values ('sql-trf-${RUN}', '${w}', 1000, 'XOF', 'transfer', 'completed', 'SQL-TRF-${RUN}'); insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('sql-e3-${RUN}', 'sql-trf-${RUN}', 'platform_float', 'platform', 1000, 0, 'XOF', 'transfer'), ('sql-e4-${RUN}', 'sql-trf-${RUN}', '${w}', 'wallet', 0, 1000, 'XOF', 'transfer'); commit;`);
  chk("A8g SQL: a 'transfer' drawing on platform_float is refused (FLOAT_DEBIT_WITHOUT_AUTHORITY)", /FLOAT_DEBIT_WITHOUT_AUTHORITY/.test(e2), e2);
  const pending = (await initiate(w, 1000)).b.request.id;
  const e3 = sqlFail(`begin; insert into transactions (id, to_wallet_id, amount, currency, type, status, reference, metadata) values ('sql-cin-${RUN}', '${w}', 1000, 'XOF', 'deposit', 'completed', 'SQL-CIN-${RUN}', '{"authority":"cash_in_request","cashInRequestId":"${pending}"}'); insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('sql-e5-${RUN}', 'sql-cin-${RUN}', 'platform_float', 'platform', 1000, 0, 'XOF', 'deposit'), ('sql-e6-${RUN}', 'sql-cin-${RUN}', '${w}', 'wallet', 0, 1000, 'XOF', 'deposit'); commit;`);
  chk("A8h SQL: a deposit naming a request that is not EXECUTED is refused (DEPOSIT_CASH_IN_MISMATCH)", /DEPOSIT_CASH_IN_MISMATCH/.test(e3), e3);
  const e4 = sqlFail(`begin; insert into transactions (id, to_wallet_id, amount, currency, type, status, reference, metadata) values ('sql-fake-${RUN}', '${w}', 1000, 'XOF', 'deposit', 'completed', 'SQL-FAKE-${RUN}', '{"authority":"cash_in_request","cashInRequestId":"nope"}'); insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('sql-e7-${RUN}', 'sql-fake-${RUN}', 'platform_float', 'platform', 1000, 0, 'XOF', 'deposit'), ('sql-e8-${RUN}', 'sql-fake-${RUN}', '${w}', 'wallet', 0, 1000, 'XOF', 'deposit'); commit;`);
  chk("A8i SQL: a deposit naming an unknown request is refused", /DEPOSIT_UNKNOWN_CASH_IN_REQUEST/.test(e4), e4);
  const e5 = sqlFail(`begin; insert into transactions (id, to_wallet_id, amount, currency, type, status, reference, metadata) values ('sql-auth-${RUN}', '${w}', 1000, 'XOF', 'deposit', 'completed', 'SQL-AUTH-${RUN}', '{"authority":"because_i_said_so"}'); insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('sql-e9-${RUN}', 'sql-auth-${RUN}', 'platform_float', 'platform', 1000, 0, 'XOF', 'deposit'), ('sql-e10-${RUN}', 'sql-auth-${RUN}', '${w}', 'wallet', 0, 1000, 'XOF', 'deposit'); commit;`);
  chk("A8j SQL: an invented authority is refused", /DEPOSIT_UNKNOWN_AUTHORITY/.test(e5), e5);
  // Executing the pending request through SQL by hand, mimicking the service but skipping approval.
  const e6 = sqlFail(`begin; insert into transactions (id, to_wallet_id, amount, currency, type, status, reference, metadata, idempotency_key) values ('sql-exec-${RUN}', '${w}', 1000, 'XOF', 'deposit', 'completed', 'SQL-EXEC-${RUN}', '{"authority":"cash_in_request","cashInRequestId":"${pending}"}', 'cash-in:${pending}'); insert into ledger_entries (id, transaction_id, account_id, account_type, debit_amount, credit_amount, currency, event_type) values ('sql-e11-${RUN}', 'sql-exec-${RUN}', 'platform_float', 'platform', 1000, 0, 'XOF', 'deposit'), ('sql-e12-${RUN}', 'sql-exec-${RUN}', '${w}', 'wallet', 0, 1000, 'XOF', 'deposit'); update cash_in_requests set status = 'EXECUTED', transaction_id = 'sql-exec-${RUN}', executed_at = now() where id = '${pending}'; commit;`);
  chk("A8k SQL: executing a request without any approval is refused (CASH_IN_EXECUTED_WITHOUT_APPROVAL)", /CASH_IN_EXECUTED_WITHOUT_APPROVAL/.test(e6), e6);
  chk("A8l nothing of these attempts persisted", sql(`select count(*) from transactions where id like 'sql-%-${RUN}'`) === "0" && sql(`select count(*) from ledger_entries where id like 'sql-e%-${RUN}'`) === "0" && status(pending) === "PENDING_APPROVAL");
  chk("A8m wallet still empty", (await balance(u, w)) === 0);
  await post(`/admin/cash-in/${pending}/cancel`, { reason: "test" }, maker.opts);

  // Direct internal function: processDeposit refuses to run without an
  // authority, and with a cash-in authority whose request is not executed the
  // database rolls the whole thing back.
  const internal = execFileSync("npx", ["tsx", "--eval", `
    import { processDeposit } from "./src/lib/walletService";
    const w = ${JSON.stringify(w)};
    const out = {};
    (async () => {
      try { await processDeposit({ walletId: w, amount: 1000, currency: "XOF", reference: "INT-1-${RUN}" }); out.noAuthority = "accepted"; }
      catch (e) { out.noAuthority = e.name; }
      try { await processDeposit({ walletId: w, amount: 1000, currency: "XOF", reference: "INT-2-${RUN}", authority: { kind: "cash_in_request", requestId: "not-a-request" } }); out.fakeRequest = "accepted"; }
      catch (e) { const m = String(e?.cause?.message ?? e.message); out.fakeRequest = m.split(" ")[0]; }
      console.log(JSON.stringify(out));
      process.exit(0);
    })();
  `], { encoding: "utf8", env: { ...process.env, DATABASE_URL: DB, NODE_ENV: "development" }, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  const res = JSON.parse(internal.trim().split("\n").pop());
  chk("A8n internal processDeposit without authority throws DepositAuthorityError", res.noAuthority === "DepositAuthorityError", JSON.stringify(res));
  chk("A8o internal processDeposit with a fake cash-in request is rolled back by the database", res.fakeRequest === "DEPOSIT_UNKNOWN_CASH_IN_REQUEST", JSON.stringify(res));
  chk("A8p wallet still empty after the internal attempts", (await balance(u, w)) === 0 && sql(`select count(*) from transactions where reference like 'INT-%-${RUN}'`) === "0");
}

// ── A9. Trails are append-only; reconciliation ties requests to the ledger ──
console.log("\nA9. Immutable trails and reconciliation");
{
  const anyAudit = sql(`select id from audit_logs where action = 'cash_in.executed' order by timestamp desc limit 1`);
  const e1 = sqlFail(`update audit_logs set actor = 'nobody' where id = '${anyAudit}'`);
  const e2 = sqlFail(`delete from audit_logs where id = '${anyAudit}'`);
  chk("A9a audit_logs cannot be updated or deleted (APPEND_ONLY)", /APPEND_ONLY/.test(e1) && /APPEND_ONLY/.test(e2), `${e1} | ${e2}`);
  const anyDecision = sql(`select id from cash_in_decisions order by created_at desc limit 1`);
  const e3 = sqlFail(`update cash_in_decisions set admin_email = 'x' where id = '${anyDecision}'`);
  const e4 = sqlFail(`delete from cash_in_decisions where id = '${anyDecision}'`);
  chk("A9b cash_in_decisions cannot be updated or deleted", /APPEND_ONLY/.test(e3) && /APPEND_ONLY/.test(e4), `${e3} | ${e4}`);
  const report = (await get("/admin/reconciliation/report", root.opts)).b;
  const xof = report?.supply?.find((s) => s.currency === "XOF");
  chk("A9c reconciliation report is clean after the whole suite", report?.ok === true, JSON.stringify(report?.anomalies));
  chk("A9d money created under cash-in authority equals the sum of EXECUTED requests (I11)", Math.abs((xof?.createdByAuthority?.cash_in_request ?? 0) - (report?.cashIn?.executedTotal?.XOF ?? 0)) < 0.0001, `ledger=${xof?.createdByAuthority?.cash_in_request} executed=${report?.cashIn?.executedTotal?.XOF}`);
  chk("A9e conservation holds: liabilities + treasury + fees + fx = created − destroyed (I13)", xof && xof.conservationGap === 0, JSON.stringify(xof));
  chk("A9f no deposit without a known authority (I10)", report?.checks?.depositsWithoutAuthority === 0);
  chk("A9g no EXECUTED request whose ledger transaction is missing or differs", report?.cashIn?.ledgerMismatch?.length === 0);
  const list = await get("/admin/cash-in?status=EXECUTED&limit=5", support.opts);
  chk("A9h any operator role can read the request list", list.s === 200 && Array.isArray(list.b.requests));
  const listAnon = await get("/admin/cash-in");
  chk("A9i the list is not public", listAnon.s === 403 || listAnon.s === 401);
}

// ── A10. Second pass against the gate's own fixes ────────────────────────────
console.log("\nA10. Second adversarial pass");
{
  const maker2 = await ensureAdmin({ email: `cashin-maker-b2-${RUN}@kowri.test`, name: "Second maker", password: "MakerB2Passw0rd-2026", role: "operations" }, root.token);
  const cancel = (id, who) => post(`/admin/cash-in/${id}/cancel`, { reason: "test" }, asAdminToken(who.token));
  const u = await createUser({ kycLevel: 2 });
  const smuggle = await initiate(u.wallet.id, 1000, { status: "EXECUTED", approvedBy: checker.admin.id, transactionId: "x", approvalsRequired: 0, initiatedBy: "legacy-key", expiresAt: "2099-01-01" });
  chk("A10a status/approver/transaction/expiry in the body are ignored", smuggle.s === 201 && smuggle.b.request.status === "PENDING_APPROVAL" && smuggle.b.request.approvalsRequired === 1 && smuggle.b.request.transactionId === null && smuggle.b.request.initiatedBy === maker.admin.id && new Date(smuggle.b.request.expiresAt).getTime() < Date.now() + 2 * 24 * 3600_000, JSON.stringify(smuggle.b?.request ?? smuggle.b).slice(0, 160));
  await cancel(smuggle.b?.request?.id, maker);
  const arr = await initiate([u.wallet.id], 1000);
  const obj = await initiate(u.wallet.id, { toString: () => "1000" });
  const inj = await initiate(`${u.wallet.id}' or '1'='1`, 1000);
  chk("A10b array wallet id / object amount → 400, injection-looking id → 404", arr.s === 400 && obj.s === 400 && inj.s === 404, codes([arr, obj, inj]));

  const usd = (await u.post("/wallets", { currency: "USD", walletType: "personal" })).b;
  const bigUsd = await post("/admin/cash-in", { walletId: usd.id, amount: 20_000, currency: "USD", source: "other", reference: `USD-${RUN}` }, asAdminToken(maker.token, { idempotency: true }));
  chk("A10c limits are evaluated in XOF-equivalent: 20 000 USD → 409 CASH_IN_LIMIT_OPERATION", bigUsd.s === 409 && bigUsd.b?.code === "CASH_IN_LIMIT_OPERATION", codes([bigUsd]));
  const midUsd = await post("/admin/cash-in", { walletId: usd.id, amount: 2_000, currency: "usd", source: "other", reference: `USD2-${RUN}` }, asAdminToken(maker.token, { idempotency: true }));
  chk("A10d 2 000 USD crosses the XOF threshold → two signatures (currency accepted in any case)", midUsd.s === 201 && midUsd.b.request.approvalsRequired === 2 && midUsd.b.request.amountReference > THRESHOLD, `${codes([midUsd])} ref=${midUsd.b?.request?.amountReference}`);
  await cancel(midUsd.b?.request?.id, maker);

  const ref = `TWO-MAKERS-${RUN}`;
  const a = await initiate(u.wallet.id, 1000, { reference: ref });
  const b = await initiate(u.wallet.id, 1000, { reference: ref }, maker2);
  chk("A10e a second maker cannot file the same evidence → 409", a.s === 201 && b.s === 409 && b.b?.code === "CASH_IN_DUPLICATE_REFERENCE", codes([a, b]));
  const par = await Promise.all(Array.from({ length: 6 }, (_, i) => initiate(u.wallet.id, 1000, { reference: `PAR-${RUN}` }, i % 2 ? maker : maker2)));
  chk("A10f six parallel filings of one reference by two makers → exactly one accepted, others 409, never 500", par.filter((r) => r.s === 201).length === 1 && par.filter((r) => r.s !== 201).every((r) => r.s === 409), codes(par));
  for (const r of [a, ...par]) if (r.s === 201) await cancel(r.b.request.id, r.b.request.initiatedBy === maker.admin.id ? maker : maker2);

  let consistent = 0, executed = 0;
  for (let i = 0; i < 6; i++) {
    const id = (await initiate(u.wallet.id, 100)).b.request.id;
    const [c, ap] = await Promise.all([cancel(id, maker), approve(id, checker)]);
    const st = status(id); const n = txCount(id);
    if ((st === "EXECUTED" && n === 1 && ap.s === 200 && c.s === 409) || (st === "CANCELLED" && n === 0 && c.s === 200 && ap.s === 409)) consistent++;
    if (st === "EXECUTED") executed++;
  }
  chk("A10g cancel racing approve, six rounds: each ends EXECUTED with one transaction or CANCELLED with none", consistent === 6, `consistent=${consistent} executed=${executed}`);
  chk("A10h balance equals the executed rounds", (await balance(u, u.wallet.id)) === executed * 100);

  const v = await createUser({ kycLevel: 2 });
  const late = (await initiate(v.wallet.id, 1000)).b.request.id;
  sql(`update users set status = 'suspended' where id = '${v.userId}'`);
  const refused = await approve(late, checker);
  chk("A10i beneficiary suspended after filing → approval refused 409 USER_SUSPENDED, request still open, nothing credited", refused.s === 409 && refused.b?.code === "USER_SUSPENDED" && txCount(late) === 0 && status(late) === "PENDING_APPROVAL", codes([refused]));
  sql(`update users set status = 'active' where id = '${v.userId}'`);
  const again = await approve(late, checker);
  chk("A10j reinstated → the same approval executes once", again.s === 200 && txCount(late) === 1 && (await balance(v, v.wallet.id)) === 1000, codes([again]));
}

const { fail } = summary("CASH-IN MAKER-CHECKER SUITE");
process.exit(fail ? 1 : 0);
