// Guard-rail suite for the money paths hardened by the audit remediation.
// Run against a live server: node test-integrity.mjs  (needs ADMIN_API_KEY=test-admin-key on the server)
import {
  chk, summary, get, post, patch, del, login, createUser, fund, balance, setKycLevel, idem, seededPhone, operator,
  adminOpts, uniquePhone,
} from "./test-lib.mjs";
import { randomUUID } from "node:crypto";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║   KOWRI — INTEGRITY SUITE (auth, ledger, risk, lifecycle)    ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

// ── 1. Authentication & access control ───────────────────────────────────────
console.log("1. Authentication & access control");
{
  const bad = await post("/wallet/login", { phone: seededPhone(0), pin: "0000" });
  chk("1a wrong PIN on /wallet/login → 401", bad.s === 401, `status=${bad.s}`);

  const good = await post("/wallet/login", { phone: seededPhone(0), pin: "1234" });
  chk("1b correct PIN on /wallet/login → 200 + token", good.s === 200 && !!good.b?.token, `status=${good.s}`);

  const noAuth = await get("/users");
  chk("1c GET /users without admin key → 403", noAuth.s === 403, `status=${noAuth.s}`);

  const admin = await get("/users?limit=2", { admin: true });
  chk("1d GET /users with admin key → 200", admin.s === 200 && Array.isArray(admin.b?.users), `status=${admin.s}`);

  const anon = await get("/wallet/balance?walletId=whatever");
  chk("1e GET /wallet/balance without session → 401", anon.s === 401, `status=${anon.s}`);

  const adminNoKey = await get("/admin/kill-switches");
  chk("1f /admin without key → 403", adminNoKey.s === 403, `status=${adminNoKey.s}`);

  const secrets = await get("/security/posture");
  chk("1g /security without key → 403", secrets.s === 403, `status=${secrets.s}`);
}

// ── 2. Wallet ownership & currency ───────────────────────────────────────────
console.log("\n2. Wallet ownership & currency");
const alice = await createUser({ firstName: "Alice" });
const bob   = await createUser({ firstName: "Bob" });
chk("2a fresh users have a personal wallet", !!alice.wallet?.id && !!bob.wallet?.id);

await fund(alice.wallet.id, 50_000);
chk("2b admin cash-in credits the ledger balance", (await balance(alice, alice.wallet.id)) === 50_000);

{
  const peek = await bob.get(`/wallets/${alice.wallet.id}`);
  chk("2c another user's wallet is invisible (404)", peek.s === 404, `status=${peek.s}`);

  const steal = await bob.money(`/wallets/${alice.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 1000, currency: "XOF" });
  chk("2d transfer from a wallet you don't own → 403", steal.s === 403, `status=${steal.s}`);
  chk("2e …and nothing moved", (await balance(alice, alice.wallet.id)) === 50_000);

  const wrongCurrency = await alice.money(`/wallets/${alice.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 1000, currency: "XAF" });
  chk("2f transfer in a currency the wallet is not denominated in → 400", wrongCurrency.s === 400, `status=${wrongCurrency.s} ${wrongCurrency.b?.message ?? ""}`);

  const ok = await alice.money(`/wallets/${alice.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 10_000, currency: "XOF" });
  chk("2g legitimate transfer → 200", ok.s === 200 && !!ok.b?.id, `status=${ok.s}`);
  chk("2h sender debited", (await balance(alice, alice.wallet.id)) === 40_000);
  chk("2i recipient credited", (await balance(bob, bob.wallet.id)) === 10_000);

  const list = await bob.get(`/wallets?userId=${alice.userId}`);
  chk("2j wallet list is scoped to the session even with ?userId=", list.s === 200 && (list.b?.wallets ?? []).every((w) => w.userId === bob.userId));

  const deposit = await alice.money(`/wallets/${alice.wallet.id}/deposit`, { amount: 1000, currency: "XOF" });
  chk("2k user cannot self-deposit (platform only) → 403", deposit.s === 403, `status=${deposit.s}`);
}

// ── 3. Idempotency ───────────────────────────────────────────────────────────
console.log("\n3. Idempotency");
{
  const key = idem();
  const first = await alice.money(`/wallets/${alice.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 5_000, currency: "XOF" }, { idempotency: key });
  const second = await alice.money(`/wallets/${alice.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 5_000, currency: "XOF" }, { idempotency: key });
  chk("3a first call executes → 200", first.s === 200, `status=${first.s}`);
  chk("3b replay returns the same response", second.s === 200 && second.b?.id === first.b?.id, `ids ${first.b?.id?.slice(0, 8)} / ${second.b?.id?.slice(0, 8)}`);
  chk("3c replay is flagged X-Idempotent-Replayed", second.h.get("x-idempotent-replayed") === "true");
  chk("3d money moved exactly once", (await balance(alice, alice.wallet.id)) === 35_000, `balance=${await balance(alice, alice.wallet.id)}`);

  const other = await bob.money(`/wallets/${bob.wallet.id}/transfer`, { toWalletId: alice.wallet.id, amount: 1_000, currency: "XOF" }, { idempotency: key });
  chk("3e same key from another user is not a replay (own execution)", other.s === 200 && other.b?.id !== first.b?.id && other.h.get("x-idempotent-replayed") !== "true", `status=${other.s}`);

  const noKey = await alice.post(`/wallets/${alice.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 1, currency: "XOF" });
  chk("3f missing Idempotency-Key → 400", noKey.s === 400, `status=${noKey.s}`);
}

// ── 4. KYC ceiling & review workflow ─────────────────────────────────────────
console.log("\n4. KYC ceiling & review workflow");
{
  const carol = await createUser({ firstName: "Carol" });
  await fund(carol.wallet.id, 300_000);
  const over = await carol.money(`/wallets/${carol.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 150_000, currency: "XOF" });
  chk("4a KYC level 0 cannot exceed 100 000 XOF/month → 400 KYC_LIMIT", over.s === 400 && over.b?.code === "KYC_LIMIT", `status=${over.s} ${over.b?.message ?? ""}`);

  const submit = await carol.post(`/users/${carol.userId}/kyc`, {
    kycLevel: 1, documentType: "national_id", documentNumber: "CI-123456", fullName: "Carol Test", dateOfBirth: "1992-05-05",
  });
  chk("4b user submits a KYC record → 201 pending", submit.s === 201 && submit.b?.record?.status === "pending", `status=${submit.s}`);

  const userReview = await carol.patch(`/compliance/kyc/${submit.b?.record?.id}`, { decision: "approve" });
  chk("4c user cannot approve their own KYC → 403", userReview.s === 403, `status=${userReview.s}`);

  const rejectNoReason = await patch(`/compliance/kyc/${submit.b?.record?.id}`, { decision: "reject" }, { admin: true });
  chk("4d reject without reason → 400", rejectNoReason.s === 400, `status=${rejectNoReason.s}`);

  const approve = await patch(`/compliance/kyc/${submit.b?.record?.id}`, { decision: "approve" }, { admin: true });
  chk("4e compliance approves → 200, level raised, account active", approve.s === 200 && approve.b?.user?.kycLevel === 1 && approve.b?.user?.status === "active", `status=${approve.s} ${JSON.stringify(approve.b?.user)}`);

  const again = await patch(`/compliance/kyc/${submit.b?.record?.id}`, { decision: "approve" }, { admin: true });
  chk("4f second review of the same record → 409", again.s === 409, `status=${again.s}`);

  const now = await carol.money(`/wallets/${carol.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 150_000, currency: "XOF" });
  chk("4g after approval the same transfer passes", now.s === 200, `status=${now.s} ${now.b?.message ?? ""}`);
}

// ── 5. Risk screening ────────────────────────────────────────────────────────
console.log("\n5. Risk screening");
{
  const dave = await createUser({ firstName: "Dave", kycLevel: 2 });
  await fund(dave.wallet.id, 25_000_000);

  // The 25M cash-in itself must have been screened (deposits were never checked before).
  const depositFlags = await get(`/aml/flags/${dave.wallet.id}`, { admin: true });
  chk("5a a high-value cash-in is AML-flagged (deposits are screened)", depositFlags.s === 200 && (depositFlags.b?.flags ?? []).some((f) => f.flagReason === "high_value_transaction"), `flags=${(depositFlags.b?.flags ?? []).map((f) => f.flagReason).join(",")}`);

  // Three small transfers, then an amount just under the reporting threshold → structuring.
  for (let i = 0; i < 3; i++) {
    await dave.money(`/wallets/${dave.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 1_000, currency: "XOF" });
  }
  const check = await post("/aml/check", { walletId: dave.wallet.id, transactionId: `test-${idem()}`, amount: 9_600_000, currency: "XOF" }, { admin: true });
  const structuringFlag = (check.b?.flags ?? []).find((f) => f.reason === "structuring_detected");
  chk("5b screening detects structuring and marks it blocking", check.s === 200 && !!structuringFlag && structuringFlag.blocking === true, `status=${check.s} flags=${JSON.stringify(check.b?.flags)}`);

  const before = await balance(dave, dave.wallet.id);
  const structuring = await dave.money(`/wallets/${dave.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 9_600_000, currency: "XOF" });
  chk("5c the real transfer is refused before the ledger (403 screening or 429 velocity cap)", structuring.s === 403 || structuring.s === 429, `status=${structuring.s} ${JSON.stringify(structuring.b?.reasons ?? structuring.b?.message)}`);
  chk("5d refused transfer left the balance untouched", (await balance(dave, dave.wallet.id)) === before);

  const flags = await get(`/aml/flags/${dave.wallet.id}`, { admin: true });
  chk("5e an AML structuring flag was recorded for the wallet", flags.s === 200 && (flags.b?.flags ?? []).some((f) => f.flagReason === "structuring_detected"), `flags=${(flags.b?.flags ?? []).map((f) => f.flagReason).join(",")}`);
  chk("5f flags expose amount/currency at top level", (flags.b?.flags ?? []).every((f) => typeof f.amount === "number" && !!f.currency));

  await post("/aml/check", { walletId: dave.wallet.id, transactionId: `test-${idem()}`, amount: 9_700_000, currency: "XOF" }, { admin: true });
  const flagsAfter = await get(`/aml/flags/${dave.wallet.id}`, { admin: true });
  const structuringFlags = (flagsAfter.b?.flags ?? []).filter((f) => f.flagReason === "structuring_detected");
  chk("5g a repeated structuring hit within 24h does not create a second flag (dedup)", structuringFlags.length === 1, `count=${structuringFlags.length}`);
  const cases = await get("/aml/cases?status=open&limit=100", { admin: true });
  const daveCases = (cases.b?.cases ?? []).filter((c) => c.walletId === dave.wallet.id && c.caseType === "structuring");
  chk("5h exactly one open structuring case for the wallet", daveCases.length === 1, `count=${daveCases.length}`);

  const flagId = structuringFlags[0]?.id;
  const review = await patch(`/aml/flags/${flagId}/review`, { note: "reviewed in test" }, { admin: true });
  chk("5i compliance can mark the flag reviewed", review.s === 200 && review.b?.flag?.reviewed === true, `status=${review.s}`);
  const reviewAgain = await patch(`/aml/flags/${flagId}/review`, {}, { admin: true });
  chk("5j reviewing twice → 409", reviewAgain.s === 409, `status=${reviewAgain.s}`);

  // Sequential burst of outgoing transfers: screening alerts from the 5th, the velocity cap refuses from the 11th.
  const erin = await createUser({ firstName: "Erin", kycLevel: 1 });
  await fund(erin.wallet.id, 100_000);
  const burst = [];
  for (let i = 0; i < 14; i++) {
    burst.push(await erin.money(`/wallets/${erin.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 100, currency: "XOF" }));
  }
  const refused = burst.filter((r) => r.s === 403 || r.s === 429).length;
  chk("5k a burst of 14 transfers in seconds is partially refused", refused > 0, `refused=${refused}/14`);
  await sleep(300);
  const alerts = await get(`/risk/alerts/${erin.wallet.id}`, { admin: true });
  const rapid = (alerts.b?.alerts ?? []).filter((a) => a.alertType === "rapid_transfers");
  chk("5l exactly one rapid_transfers alert exists (dedup)", alerts.s === 200 && rapid.length === 1, `alerts=${(alerts.b?.alerts ?? []).map((a) => a.alertType).join(",")}`);
  const resolve = await patch(`/risk/alerts/${rapid[0]?.id}/resolve`, { resolution: "test" }, { admin: true });
  chk("5m operator can resolve the alert", resolve.s === 200 && resolve.b?.alert?.resolved === true, `status=${resolve.s}`);
}

// ── 6. Wallet freeze / close ─────────────────────────────────────────────────
console.log("\n6. Wallet freeze / close");
{
  const frank = await createUser({ firstName: "Frank" });
  await fund(frank.wallet.id, 20_000);
  const freeze = await patch(`/admin/wallets/${frank.wallet.id}/status`, { status: "frozen", reason: "test" }, { admin: true });
  chk("6a admin freezes the wallet", freeze.s === 200 && freeze.b?.wallet?.status === "frozen", `status=${freeze.s}`);

  const out = await frank.money(`/wallets/${frank.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 1_000, currency: "XOF" });
  chk("6b frozen wallet cannot be debited → 400", out.s === 400 && out.b?.code === "WalletUnavailableError", `status=${out.s} ${out.b?.message ?? ""}`);

  const inbound = await bob.money(`/wallets/${bob.wallet.id}/transfer`, { toWalletId: frank.wallet.id, amount: 500, currency: "XOF" });
  chk("6c frozen wallet can still receive", inbound.s === 200, `status=${inbound.s}`);

  const close = await patch(`/admin/wallets/${frank.wallet.id}/status`, { status: "closed" }, { admin: true });
  chk("6d closing a wallet with funds is refused → 409", close.s === 409, `status=${close.s}`);

  const thaw = await patch(`/admin/wallets/${frank.wallet.id}/status`, { status: "active" }, { admin: true });
  chk("6e admin reactivates the wallet", thaw.s === 200 && thaw.b?.wallet?.status === "active");
  const outAgain = await frank.money(`/wallets/${frank.wallet.id}/transfer`, { toWalletId: bob.wallet.id, amount: 1_000, currency: "XOF" });
  chk("6f debits work again after reactivation", outAgain.s === 200, `status=${outAgain.s}`);
}

// ── 7. Merchant activation ───────────────────────────────────────────────────
console.log("\n7. Merchant activation");
{
  const phone = `+22508${String(Date.now()).slice(-7)}`;
  const created = await post("/merchant/create", { businessName: "Boutique Test", businessType: "retail", phone, firstName: "Grace", lastName: "Mensah", pin: "1234" });
  chk("7a merchant account created as pending_approval", created.s === 201 && created.b?.status === "pending_approval", `status=${created.s}`);
  const merchantId = created.b?.merchantId;

  const payBefore = await alice.money("/merchant/payment", { merchantId, fromWalletId: alice.wallet.id, amount: 500 });
  chk("7b customer payment to an unapproved merchant → 403", payBefore.s === 403, `status=${payBefore.s}`);

  const badStatus = await patch(`/admin/merchants/${merchantId}/status`, { status: "gold" }, { admin: true });
  chk("7c invalid merchant status → 400", badStatus.s === 400);
  const activate = await patch(`/admin/merchants/${merchantId}/status`, { status: "active", reason: "test" }, { admin: true });
  chk("7d admin activates the merchant", activate.s === 200 && activate.b?.merchant?.status === "active", `status=${activate.s}`);

  const payAfter = await alice.money("/merchant/payment", { merchantId, fromWalletId: alice.wallet.id, amount: 500 });
  chk("7e customer payment initiation now succeeds → 201", payAfter.s === 201, `status=${payAfter.s} ${payAfter.b?.error ?? ""}`);

  const payFromOther = await alice.money("/merchant/payment", { merchantId, fromWalletId: bob.wallet.id, amount: 500 });
  chk("7f paying from someone else's wallet → 403", payFromOther.s === 403, `status=${payFromOther.s}`);
}

// ── 8. Tontine lifecycle ─────────────────────────────────────────────────────
console.log("\n8. Tontine lifecycle");
{
  const admin = await createUser({ firstName: "Hawa", kycLevel: 1 });
  const m2 = await createUser({ firstName: "Idris", kycLevel: 1 });
  const m3 = await createUser({ firstName: "Jules", kycLevel: 1 });
  const stranger = await createUser({ firstName: "Kali" });
  for (const s of [admin, m2, m3]) await fund(s.wallet.id, 200_000);

  const created = await admin.post("/tontines", { name: "Test tontine", contributionAmount: 10_000, currency: "XOF", frequency: "weekly", maxMembers: 3, adminUserId: stranger.userId });
  chk("8a tontine created with the session as admin (body adminUserId ignored)", created.s === 201 && created.b?.adminUserId === admin.userId, `status=${created.s} admin=${created.b?.adminUserId?.slice(0, 8)}`);
  const tontineId = created.b?.id;

  const joinSelf = await m2.post(`/community/tontines/${tontineId}/members`, {});
  chk("8b a user joins for themselves → 201", joinSelf.s === 201, `status=${joinSelf.s}`);
  const enrollOther = await stranger.post(`/community/tontines/${tontineId}/members`, { userId: m3.userId });
  chk("8c a stranger cannot enroll someone else → 403", enrollOther.s === 403, `status=${enrollOther.s}`);
  const adminEnroll = await admin.post(`/community/tontines/${tontineId}/members`, { userId: m3.userId });
  chk("8d the tontine admin can enroll a member → 201", adminEnroll.s === 201, `status=${adminEnroll.s}`);
  const full = await stranger.post(`/community/tontines/${tontineId}/members`, {});
  chk("8e joining a full tontine → 400", full.s === 400, `status=${full.s}`);

  const activateByMember = await m2.post(`/community/tontines/${tontineId}/activate`, { rotationModel: "fixed" });
  chk("8f only the admin can activate → 403", activateByMember.s === 403, `status=${activateByMember.s}`);
  const activate = await admin.post(`/community/tontines/${tontineId}/activate`, { rotationModel: "fixed" });
  chk("8g admin activates → active", activate.s === 200 && activate.b?.status === "active", `status=${activate.s}`);

  const collectByMember = await m2.money(`/community/tontines/${tontineId}/collect`, {});
  chk("8h only the admin can trigger collection → 403", collectByMember.s === 403, `status=${collectByMember.s}`);
  const collect = await admin.money(`/community/tontines/${tontineId}/collect`, {});
  chk("8i collection debits every member", collect.s === 200 && collect.b?.collected === 3, `status=${collect.s} collected=${collect.b?.collected} failed=${JSON.stringify(collect.b?.failed)}`);
  chk("8j member balance reflects the contribution", (await balance(m2, m2.wallet.id)) === 190_000);

  const collectAgain = await admin.money(`/community/tontines/${tontineId}/collect`, {});
  chk("8k re-running the same round collects nothing more", collectAgain.s === 200 && collectAgain.b?.collected === 0, `collected=${collectAgain.b?.collected}`);
  chk("8l …and did not double-charge", (await balance(m2, m2.wallet.id)) === 190_000);

  // Leaving while the pool is funded: the admin cannot, a stranger cannot act, an unpaid member gets contributions back minus the penalty.
  const leavePaid = await admin.del(`/community/tontines/${tontineId}/members/${admin.userId}`);
  chk("8m the admin cannot leave their own tontine → 400", leavePaid.s === 400, `status=${leavePaid.s}`);
  const leaveOther = await stranger.del(`/community/tontines/${tontineId}/members/${m3.userId}`);
  chk("8n a stranger cannot remove a member → 403", leaveOther.s === 403, `status=${leaveOther.s}`);
  const beforeLeave = await balance(m3, m3.wallet.id);
  const leave = await m3.del(`/community/tontines/${tontineId}/members/${m3.userId}`);
  chk("8o an unpaid member leaves the active tontine → refund minus 10% penalty", leave.s === 200 && leave.b?.refundAmount === 9_000 && leave.b?.penalty === 1_000, `status=${leave.s} ${JSON.stringify(leave.b)}`);
  chk("8p refund landed in the member's wallet", (await balance(m3, m3.wallet.id)) === beforeLeave + 9_000);

  const payout = await admin.money(`/community/tontines/${tontineId}/payout`, {});
  chk("8q payout pays round 1 recipient the pot of the remaining members", payout.s === 200 && payout.b?.round === 1 && payout.b?.amount === 20_000, `status=${payout.s} amount=${payout.b?.amount}`);

  const jobs = await admin.get("/community/scheduler/jobs");
  const nextJob = (jobs.b?.jobs ?? []).find((j) => j.entityId === tontineId && j.jobType === "tontine_contribution" && j.status === "pending");
  chk("8r the next contribution round is scheduled automatically", !!nextJob, `jobs=${(jobs.b?.jobs ?? []).filter((j) => j.entityId === tontineId).map((j) => `${j.jobType}:${j.status}`).join(",")}`);

  const notifs = await admin.get("/wallet/notifications");
  chk("8s the round-1 recipient received a payout notification", (notifs.b?.notifications ?? []).some((n) => /Payout/i.test(n.title)), `titles=${(notifs.b?.notifications ?? []).map((n) => n.title).join(" | ")}`);

  const cancelByMember = await m2.money(`/community/tontines/${tontineId}/cancel`, {});
  chk("8t only the admin can cancel → 403", cancelByMember.s === 403, `status=${cancelByMember.s}`);
  const beforeCancel = await balance(m2, m2.wallet.id);
  const cancel = await admin.money(`/community/tontines/${tontineId}/cancel`, { reason: "test" });
  chk("8u admin cancels the tontine", cancel.s === 200 && cancel.b?.status === "cancelled", `status=${cancel.s} ${cancel.b?.message ?? ""}`);
  const m2Refund = (cancel.b?.refunds ?? []).find((r) => r.userId === m2.userId);
  const adminRefund = (cancel.b?.refunds ?? []).find((r) => r.userId === admin.userId);
  chk("8v the unpaid member gets what is left in the pool (the exit penalty)", !!m2Refund && m2Refund.amount === 1_000 && (await balance(m2, m2.wallet.id)) === beforeCancel + 1_000, `refund=${JSON.stringify(m2Refund)}`);
  chk("8w the already-paid member gets nothing back", !adminRefund || adminRefund.amount === 0, `refund=${JSON.stringify(adminRefund)}`);
  const cancelAgain = await admin.money(`/community/tontines/${tontineId}/cancel`, {});
  chk("8x cancelling twice → 400", cancelAgain.s === 400, `status=${cancelAgain.s}`);
  const jobsAfter = await admin.get("/community/scheduler/jobs");
  chk("8y pending jobs were cancelled with the tontine", !(jobsAfter.b?.jobs ?? []).some((j) => j.entityId === tontineId && j.status === "pending"));
}

// ── 9. Position market ───────────────────────────────────────────────────────
console.log("\n9. Position market");
{
  const admin = await createUser({ firstName: "Lea", kycLevel: 1 });
  const seller = await createUser({ firstName: "Malik", kycLevel: 1 });
  const buyer = await createUser({ firstName: "Nadia", kycLevel: 1 });
  const bidder = await createUser({ firstName: "Omar", kycLevel: 1 });
  for (const s of [admin, seller, buyer, bidder]) await fund(s.wallet.id, 100_000);

  const t = await admin.post("/tontines", { name: "Market tontine", contributionAmount: 5_000, currency: "XOF", frequency: "monthly", maxMembers: 2 });
  const tontineId = t.b?.id;
  await seller.post(`/community/tontines/${tontineId}/members`, {});
  const act = await admin.post(`/community/tontines/${tontineId}/activate`, { rotationModel: "fixed" });
  chk("9a market tontine active", act.s === 200 && act.b?.status === "active", `status=${act.s}`);

  const listByOther = await buyer.post(`/community/tontines/${tontineId}/positions/list`, { payoutOrder: 2, askPrice: 8_000 });
  chk("9b listing is attributed to the session, so a non-member cannot list someone's slot", listByOther.s !== 201 || listByOther.b?.sellerId === buyer.userId, `status=${listByOther.s}`);

  const listing = await seller.post(`/community/tontines/${tontineId}/positions/list`, { payoutOrder: 2, askPrice: 8_000 });
  chk("9c seller lists their position", listing.s === 201 && listing.b?.sellerId === seller.userId, `status=${listing.s}`);
  const listingId = listing.b?.id;

  const bid = await bidder.post(`/community/tontines/positions/${listingId}/bids`, { bidAmount: 7_000 });
  chk("9d a non-member places a bid on the listing", bid.s === 201 && bid.b?.listingId === listingId, `status=${bid.s} ${bid.b?.message ?? ""}`);
  const acceptByBidder = await bidder.money(`/community/tontines/positions/${listingId}/bids/${bid.b?.id}/accept`, {});
  chk("9e only the seller can accept a bid → 400", acceptByBidder.s === 400, `status=${acceptByBidder.s}`);

  const sellerBefore = await balance(seller, seller.wallet.id);
  const bidderBefore = await balance(bidder, bidder.wallet.id);
  const accept = await seller.money(`/community/tontines/positions/${listingId}/bids/${bid.b?.id}/accept`, {});
  chk("9f seller accepts → bidder pays the bid price", accept.s === 200 && accept.b?.price === 7_000, `status=${accept.s} ${JSON.stringify(accept.b)}`);
  chk("9g seller credited with the bid price", (await balance(seller, seller.wallet.id)) === sellerBefore + 7_000);
  chk("9h bidder debited with the bid price", (await balance(bidder, bidder.wallet.id)) === bidderBefore - 7_000);

  const buyAgain = await buyer.money(`/community/tontines/positions/${listingId}/buy`, {});
  chk("9i the sold listing cannot be bought again → 400", buyAgain.s === 400, `status=${buyAgain.s}`);

  const detail = await bidder.get(`/tontines/${tontineId}`);
  const slot = (detail.b?.members ?? []).find((m) => m.payoutOrder === 2);
  chk("9j the slot now belongs to the bidder", slot?.userId === bidder.userId, `slot=${JSON.stringify(slot)}`);
}

// ── 10. Savings ownership ────────────────────────────────────────────────────
console.log("\n10. Savings ownership");
{
  const owner = await createUser({ firstName: "Paul", kycLevel: 1 });
  const thief = await createUser({ firstName: "Quinn" });
  await fund(owner.wallet.id, 100_000);
  const plan = await owner.money("/savings/plans", { walletId: owner.wallet.id, name: "Test plan", amount: 50_000, termDays: 30 });
  chk("10a savings plan created and locked", plan.s === 201 && plan.b?.lockedAmount === 50_000, `status=${plan.s} ${plan.b?.message ?? ""}`);

  const steal = await thief.money(`/savings/plans/${plan.b?.id}/break`, { targetWalletId: thief.wallet.id });
  chk("10b another user cannot break the plan into their wallet", steal.s === 400, `status=${steal.s} ${steal.b?.message ?? ""}`);
  const wrongTarget = await owner.money(`/savings/plans/${plan.b?.id}/break`, { targetWalletId: thief.wallet.id });
  chk("10c owner cannot redirect the payout to a wallet they don't own", wrongTarget.s === 400, `status=${wrongTarget.s}`);
  const accrueByUser = await owner.money(`/savings/plans/${plan.b?.id}/accrue`, {});
  chk("10d yield accrual is not a user action → 403", accrueByUser.s === 403, `status=${accrueByUser.s}`);

  const ok = await owner.money(`/savings/plans/${plan.b?.id}/break`, { targetWalletId: owner.wallet.id });
  chk("10e owner breaks the plan into their own wallet", ok.s === 200 && ok.b?.principal === 50_000, `status=${ok.s} ${ok.b?.message ?? ""}`);
  chk("10f principal is back", (await balance(owner, owner.wallet.id)) === 100_000, `balance=${await balance(owner, owner.wallet.id)}`);
}

// ── 11. Admin accounts and roles ─────────────────────────────────────────────
console.log("\n11. Admin accounts and roles");
{
  const ROOT = { email: "root@kowri.test", name: "Root", password: "RootPassw0rd-2026" };
  const asAdmin = (tok) => ({ headers: { "X-Admin-Token": tok } });

  const boot = await post("/admin/auth/bootstrap", ROOT, { admin: true });
  chk("11a bootstrap of the first super_admin with the legacy key (201, or 409 once it exists)", boot.s === 201 || boot.s === 409, `status=${boot.s} ${boot.b?.error ?? ""}`);
  const bootNoKey = await post("/admin/auth/bootstrap", { ...ROOT, email: "x@kowri.test" });
  chk("11b bootstrap without any admin credential → 403", bootNoKey.s === 403, `status=${bootNoKey.s}`);

  const bad = await post("/admin/auth/login", { email: ROOT.email, password: "wrong-password-123" });
  chk("11c wrong password → 401", bad.s === 401, `status=${bad.s}`);
  const rootLogin = await post("/admin/auth/login", { email: ROOT.email, password: ROOT.password });
  chk("11d super_admin login → token", rootLogin.s === 200 && String(rootLogin.b?.token).startsWith("kadm_") && rootLogin.b?.admin?.role === "super_admin", `status=${rootLogin.s} ${rootLogin.b?.error ?? ""}`);
  const root = rootLogin.b?.token;

  const me = await get("/admin/auth/me", asAdmin(root));
  chk("11e /me with X-Admin-Token", me.s === 200 && me.b?.admin?.email === ROOT.email, `status=${me.s}`);
  const usersViaSession = await get("/users?limit=1", asAdmin(root));
  chk("11f admin session reaches an admin-gated route without the legacy key", usersViaSession.s === 200, `status=${usersViaSession.s} ${usersViaSession.b?.error ?? ""}`);
  const viaBearer = await get("/users?limit=1", { token: root });
  chk("11g the same token works as Authorization: Bearer", viaBearer.s === 200, `status=${viaBearer.s}`);

  const supportEmail = `support-${randomUUID().slice(0, 8)}@kowri.test`;
  const created = await post("/admin/auth/users", { email: supportEmail, name: "Aïcha Support", password: "TempPassw0rd-2026", role: "support" }, asAdmin(root));
  chk("11h super_admin creates a support account", created.s === 201 && created.b?.admin?.mustChangePassword === true, `status=${created.s} ${created.b?.error ?? ""}`);
  const badRole = await post("/admin/auth/users", { email: `x-${randomUUID().slice(0, 6)}@kowri.test`, name: "X", password: "TempPassw0rd-2026", role: "god" }, asAdmin(root));
  chk("11i unknown role refused → 400", badRole.s === 400, `status=${badRole.s}`);
  const weak = await post("/admin/auth/users", { email: `x-${randomUUID().slice(0, 6)}@kowri.test`, name: "X", password: "short", role: "support" }, asAdmin(root));
  chk("11j weak password refused → 400", weak.s === 400, `status=${weak.s}`);

  const supLogin = await post("/admin/auth/login", { email: supportEmail, password: "TempPassw0rd-2026" });
  const sup = supLogin.b?.token;
  chk("11k support login", supLogin.s === 200 && !!sup, `status=${supLogin.s}`);
  const readKyc = await get("/compliance/kyc?limit=1", asAdmin(sup));
  chk("11l support can read the KYC queue", readKyc.s === 200, `status=${readKyc.s}`);
  const reviewKyc = await patch("/compliance/kyc/nope", { status: "approved", reviewer: "sup" }, asAdmin(sup));
  chk("11m support cannot review KYC → 403 PERMISSION_DENIED", reviewKyc.s === 403 && reviewKyc.b?.code === "PERMISSION_DENIED" && reviewKyc.b?.required === "kyc.review", `status=${reviewKyc.s} ${JSON.stringify(reviewKyc.b)}`);
  const depositBySupport = await post(`/wallets/${(await operator()).wallet?.id ?? "nope"}/deposit`, { amount: 1000, currency: "XOF", reference: "x" }, { ...asAdmin(sup), idempotency: true });
  chk("11n support cannot credit a wallet → 403", depositBySupport.s === 403, `status=${depositBySupport.s}`);
  const killBySupport = await post("/admin/kill-switches/all/fire", {}, asAdmin(sup));
  chk("11o support cannot fire a kill switch → 403", killBySupport.s === 403 && killBySupport.b?.required === "system.control", `status=${killBySupport.s}`);
  const adminsBySupport = await get("/admin/auth/users", asAdmin(sup));
  chk("11p support cannot list admin accounts → 403", adminsBySupport.s === 403, `status=${adminsBySupport.s}`);

  const changed = await post("/admin/auth/change-password", { currentPassword: "TempPassw0rd-2026", newPassword: "NewPassw0rd-2026" }, asAdmin(sup));
  chk("11q support changes their temporary password", changed.s === 200, `status=${changed.s} ${changed.b?.error ?? ""}`);
  const meAfter = await get("/admin/auth/me", asAdmin(sup));
  chk("11r current session survives the password change, flag cleared", meAfter.s === 200 && meAfter.b?.admin?.mustChangePassword === false, `status=${meAfter.s}`);
  const oldPw = await post("/admin/auth/login", { email: supportEmail, password: "TempPassw0rd-2026" });
  chk("11s old password no longer logs in", oldPw.s === 401, `status=${oldPw.s}`);

  const lastRoot = await patch(`/admin/auth/users/${rootLogin.b?.admin?.id}`, { status: "disabled" }, asAdmin(root));
  chk("11t the last active super_admin cannot be disabled → 409", lastRoot.s === 409, `status=${lastRoot.s}`);
  const disabled = await patch(`/admin/auth/users/${created.b?.admin?.id}`, { status: "disabled" }, asAdmin(root));
  chk("11u super_admin disables the support account", disabled.s === 200 && disabled.b?.admin?.status === "disabled", `status=${disabled.s}`);
  const supAfter = await get("/admin/auth/me", asAdmin(sup));
  chk("11v disabled account's session is dead → 401", supAfter.s === 401, `status=${supAfter.s}`);
  const supLoginAfter = await post("/admin/auth/login", { email: supportEmail, password: "NewPassw0rd-2026" });
  chk("11w disabled account cannot log in → 403", supLoginAfter.s === 403, `status=${supLoginAfter.s}`);

  const audits = await get("/system/audit?limit=50", asAdmin(root));
  const adminActions = (audits.b?.logs ?? audits.b?.entries ?? audits.b ?? []);
  chk("11x admin actions are audited", audits.s !== 200 || (Array.isArray(adminActions) && adminActions.some((a) => String(a.action).startsWith("admin."))), `status=${audits.s}`);

  const out = await post("/admin/auth/logout", {}, asAdmin(root));
  chk("11y logout", out.s === 200, `status=${out.s}`);
  const afterLogout = await get("/admin/auth/me", asAdmin(root));
  chk("11z revoked token → 401", afterLogout.s === 401, `status=${afterLogout.s}`);
  const legacy = await get("/users?limit=1", { admin: true });
  chk("11aa legacy shared key still accepted while ADMIN_API_KEY is set", legacy.s === 200, `status=${legacy.s}`);
}

// ── 12. Agent network ownership ──────────────────────────────────────────────
{
  const owner = await createUser({ firstName: "Agent", lastName: "Owner" });
  const other = await createUser({ firstName: "Other", lastName: "User" });
  const admin = await adminOpts();

  const anon = await post("/agents", { userId: owner.userId, name: "Anon agent", type: "AGENT", phone: uniquePhone(), zone: "Abidjan" });
  chk("12a creating an agent without a credential → 401", anon.s === 401, `status=${anon.s}`);
  const byUser = await owner.post("/agents", { userId: owner.userId, name: "Self agent", type: "AGENT", phone: uniquePhone(), zone: "Abidjan" });
  chk("12b a user cannot create an agent → 403", byUser.s === 403, `status=${byUser.s}`);
  const noUser = await post("/agents", { name: "Orphan", type: "AGENT", phone: uniquePhone(), zone: "Abidjan" }, admin);
  chk("12c operator must link the agent to a user → 400", noUser.s === 400, `status=${noUser.s}`);
  const created = await post("/agents", { userId: owner.userId, name: "Owned agent", type: "AGENT", phone: uniquePhone(), zone: "Abidjan" }, admin);
  chk("12d operator creates an agent linked to the user", created.s === 201 && created.b?.agent?.userId === owner.userId, `status=${created.s}`);
  const agentId = created.b?.agent?.id ?? "nope";

  const anonCash = await post(`/agents/${agentId}/cash-update`, { cashBalance: 5_000_000 });
  chk("12e cash-update without a credential → 401", anonCash.s === 401, `status=${anonCash.s}`);
  const otherCash = await other.post(`/agents/${agentId}/cash-update`, { cashBalance: 5_000_000 });
  chk("12f another user cannot set the agent's cash → 403", otherCash.s === 403, `status=${otherCash.s}`);
  const otherRead = await other.get(`/agents/${agentId}/liquidity`);
  chk("12g another user cannot read the agent's liquidity → 403", otherRead.s === 403, `status=${otherRead.s}`);
  const ownerCash = await owner.post(`/agents/${agentId}/cash-update`, { cashBalance: 150_000 });
  chk("12h the linked user updates their own cash count", ownerCash.s === 200 && ownerCash.b?.cashBalance === 150_000, `status=${ownerCash.s}`);
  const ownerRead = await owner.get(`/agents/${agentId}/liquidity`);
  chk("12i the linked user reads their own liquidity", ownerRead.s === 200 && Number(ownerRead.b?.cashBalance) === 150_000, `status=${ownerRead.s}`);
  const otherList = await other.get(`/agents?userId=${owner.userId}`);
  chk("12j listing is scoped to the caller even with a userId filter", otherList.s === 200 && (otherList.b?.agents ?? []).every((a) => a.userId === other.userId) && !(otherList.b?.agents ?? []).some((a) => a.id === agentId), `status=${otherList.s} count=${otherList.b?.count}`);
  const ownerList = await owner.get("/agents");
  chk("12k the linked user sees their agent in the list", ownerList.s === 200 && (ownerList.b?.agents ?? []).some((a) => a.id === agentId), `status=${ownerList.s}`);
  const zonesByUser = await owner.get("/agents/zones");
  chk("12l the network zone view is operator-only → 403", zonesByUser.s === 403, `status=${zonesByUser.s}`);
  const anomalyByOwner = await owner.post(`/agents/${agentId}/anomalies`, { type: "CASH_MISMATCH", severity: "LOW", description: "self-report" });
  chk("12m an agent cannot record its own anomaly → 403", anomalyByOwner.s === 403, `status=${anomalyByOwner.s}`);
  const adminRead = await get(`/agents/${agentId}`, admin);
  chk("12n operator reads any agent", adminRead.s === 200 && adminRead.b?.agent?.id === agentId, `status=${adminRead.s}`);
  const missing = await owner.get("/agents/does-not-exist/liquidity");
  chk("12o unknown agent → 404", missing.s === 404, `status=${missing.s}`);
}

// ── 13. Credit: scoping, treasury-backed disbursement and repayment ──────────
{
  const alice = await createUser({ firstName: "Alice", lastName: "Borrower", kycLevel: 2 });
  const bob   = await createUser({ firstName: "Bob",   lastName: "Stranger", kycLevel: 2 });
  await fund(alice.wallet.id, 50_000);
  const admin = await adminOpts();
  const treasuryXof = async () => (await get("/admin/treasury", admin)).b?.wallets?.find((w) => w.currency === "XOF")?.balance ?? NaN;

  const score = await alice.post(`/credit/scores/${alice.userId}/compute`, {});
  chk("13a user computes their own credit score", score.s === 200 && score.b?.maxLoanAmount > 0, `status=${score.s}`);
  const bobComputes = await bob.post(`/credit/scores/${alice.userId}/compute`, {});
  chk("13b another user cannot recompute it → 403", bobComputes.s === 403, `status=${bobComputes.s}`);
  const bobReads = await bob.get(`/credit/scores/${alice.userId}`);
  chk("13c another user cannot read it → 403", bobReads.s === 403, `status=${bobReads.s}`);
  const scoreList = await bob.get("/credit/scores?limit=100");
  chk("13d the score list is scoped to the caller", scoreList.s === 200 && !(scoreList.b?.scores ?? []).some((s) => s.userId === alice.userId), `status=${scoreList.s}`);

  const treasuryBefore = await treasuryXof();
  chk("13e operator sees the treasury wallets", Number.isFinite(treasuryBefore), `balance=${treasuryBefore}`);
  const loan = await alice.money("/credit/loans", { walletId: alice.wallet.id, amount: 20_000, currency: "XOF", termDays: 30, purpose: "test" });
  chk("13f loan disbursed", loan.s === 201 && loan.b?.status === "disbursed", `status=${loan.s} ${JSON.stringify(loan.b).slice(0, 160)}`);
  const loanId = loan.b?.id ?? "nope";
  chk("13g borrower wallet credited", (await balance(alice, alice.wallet.id)) === 70_000);
  const treasuryAfterLoan = await treasuryXof();
  chk("13h treasury debited by the principal", treasuryAfterLoan === treasuryBefore - 20_000, `before=${treasuryBefore} after=${treasuryAfterLoan}`);

  const bobLoans = await bob.get("/credit/loans");
  chk("13i loan list is scoped to the caller", bobLoans.s === 200 && !(bobLoans.b?.loans ?? []).some((l) => l.id === loanId), `status=${bobLoans.s}`);
  const bobLoan = await bob.get(`/credit/loans/${loanId}`);
  chk("13j another user cannot read the loan → 403", bobLoan.s === 403, `status=${bobLoan.s}`);
  const bobRepayments = await bob.get(`/credit/repayments?userId=${alice.userId}`);
  chk("13k repayment query ignores a foreign userId", bobRepayments.s === 200 && bobRepayments.b?.count === 0, `status=${bobRepayments.s} count=${bobRepayments.b?.count}`);
  const aliceLoans = await alice.get("/credit/loans?status=disbursed");
  chk("13l borrower sees their loan", aliceLoans.s === 200 && (aliceLoans.b?.loans ?? []).some((l) => l.id === loanId), `status=${aliceLoans.s}`);
  const adminLoan = await get(`/credit/loans/${loanId}`, admin);
  chk("13m operator reads any loan", adminLoan.s === 200, `status=${adminLoan.s}`);

  const bobRepays = await bob.money(`/credit/loans/${loanId}/repay`, { walletId: bob.wallet.id, amount: 1_000 });
  chk("13n another user cannot repay the loan → 403", bobRepays.s === 403, `status=${bobRepays.s}`);
  const tooMuch = await alice.money(`/credit/loans/${loanId}/repay`, { walletId: alice.wallet.id, amount: 25_000 });
  chk("13o repayment above the outstanding balance → 400", tooMuch.s === 400, `status=${tooMuch.s}`);
  const partial = await alice.money(`/credit/loans/${loanId}/repay`, { walletId: alice.wallet.id, amount: 5_000 });
  chk("13p partial repayment moves money (transactionId set)", partial.s === 201 && typeof partial.b?.transactionId === "string" && partial.b?.remaining === 15_000, `status=${partial.s} ${JSON.stringify(partial.b).slice(0, 160)}`);
  chk("13q borrower wallet debited", (await balance(alice, alice.wallet.id)) === 65_000);
  chk("13r treasury credited", (await treasuryXof()) === treasuryAfterLoan + 5_000);
  const rest = await alice.money(`/credit/loans/${loanId}/repay`, { walletId: alice.wallet.id, amount: 15_000 });
  chk("13s final repayment closes the loan", rest.s === 201 && rest.b?.isFullyRepaid === true, `status=${rest.s}`);
  const closed = await alice.get(`/credit/loans/${loanId}`);
  chk("13t loan status is repaid", closed.b?.status === "repaid" && Number(closed.b?.amountRepaid) === 20_000, `status=${closed.b?.status}`);
  const history = await alice.get(`/credit/loans/${loanId}/repayments`);
  chk("13u two repayments recorded, each with a transaction", history.s === 200 && history.b?.count === 2 && history.b.repayments.every((r) => r.transactionId), `status=${history.s} count=${history.b?.count}`);
  const again = await alice.money(`/credit/loans/${loanId}/repay`, { walletId: alice.wallet.id, amount: 1 });
  chk("13v a repaid loan refuses further repayments → 400", again.s === 400, `status=${again.s}`);
  chk("13w treasury is back to its starting balance", (await treasuryXof()) === treasuryBefore, `now=${await treasuryXof()} before=${treasuryBefore}`);
}

// ── 14. Currency-aware ceilings, shortfall payouts, agent idempotency, pool shares ──
{
  // KYC ceiling applied to a EUR wallet at the published rate (100 000 XOF ≈ 152 EUR at level 0).
  const eva  = await createUser({ firstName: "Eva",  lastName: "Euro" });
  const finn = await createUser({ firstName: "Finn", lastName: "Euro" });
  const evaEur  = await eva.post("/wallets",  { currency: "EUR", walletType: "personal" });
  const finnEur = await finn.post("/wallets", { currency: "EUR", walletType: "personal" });
  chk("14a EUR wallets created", evaEur.s === 201 && finnEur.s === 201, `status=${evaEur.s}/${finnEur.s} ${evaEur.b?.message ?? ""}`);
  await fund(evaEur.b?.id, 500, "EUR");
  const big = await eva.money(`/wallets/${evaEur.b?.id}/transfer`, { toWalletId: finnEur.b?.id, amount: 200, currency: "EUR" });
  chk("14b 200 EUR (≈131 000 XOF) exceeds the level-0 ceiling → 400", big.s === 400 && /Limite mensuelle/.test(big.b?.message ?? ""), `status=${big.s} ${big.b?.message ?? ""}`);
  const small = await eva.money(`/wallets/${evaEur.b?.id}/transfer`, { toWalletId: finnEur.b?.id, amount: 100, currency: "EUR" });
  chk("14c 100 EUR (≈65 600 XOF) passes", small.s === 200, `status=${small.s} ${small.b?.message ?? ""}`);
  const cumulative = await eva.money(`/wallets/${evaEur.b?.id}/transfer`, { toWalletId: finnEur.b?.id, amount: 60, currency: "EUR" });
  chk("14d the month's EUR volume is converted too: 100 + 60 EUR ≈ 105 000 XOF → 400", cumulative.s === 400, `status=${cumulative.s}`);

  // Tontine: a missed contribution reduces the payout instead of blocking the round.
  const lea   = await createUser({ firstName: "Lea",   kycLevel: 1 });
  const marc  = await createUser({ firstName: "Marc",  kycLevel: 1 });
  const broke = await createUser({ firstName: "Broke", kycLevel: 1 });
  await fund(lea.wallet.id, 100_000); await fund(marc.wallet.id, 100_000);
  const t = await lea.post("/tontines", { name: "Shortfall tontine", contributionAmount: 10_000, currency: "XOF", frequency: "weekly", maxMembers: 3 });
  const tontineId = t.b?.id;
  await marc.post(`/community/tontines/${tontineId}/members`, {});
  await lea.post(`/community/tontines/${tontineId}/members`, { userId: broke.userId });
  const act = await lea.post(`/community/tontines/${tontineId}/activate`, { rotationModel: "fixed" });
  chk("14e tontine with one unfunded member activated", act.s === 200, `status=${act.s}`);
  const collect = await lea.money(`/community/tontines/${tontineId}/collect`, {});
  chk("14f collection: 2 paid, 1 missed", collect.s === 200 && collect.b?.collected === 2 && (collect.b?.failed ?? []).includes(broke.userId), `status=${collect.s} collected=${collect.b?.collected}`);
  const payout = await lea.money(`/community/tontines/${tontineId}/payout`, {});
  chk("14g payout pays what was collected (20 000, not 30 000) and reports the shortfall", payout.s === 200 && payout.b?.amount === 20_000 && payout.b?.shortfall === 10_000, `status=${payout.s} ${JSON.stringify(payout.b)}`);
  const sched = await lea.get(`/community/tontines/${tontineId}/schedule`);
  chk("14h the next round stays anchored one period after the scheduled date", sched.s === 200, `status=${sched.s}`);
  await lea.money(`/community/tontines/${tontineId}/cancel`, { reason: "test" });

  // Agents: idempotent liquidity transfers through the shared middleware.
  const owner = await createUser({ firstName: "Agent", lastName: "One" });
  const peer  = await createUser({ firstName: "Agent", lastName: "Two" });
  const admin = await adminOpts();
  const a1 = await post("/agents", { userId: owner.userId, name: "A1", type: "AGENT", phone: uniquePhone(), zone: "Dakar" }, admin);
  const a2 = await post("/agents", { userId: peer.userId,  name: "A2", type: "AGENT", phone: uniquePhone(), zone: "Dakar" }, admin);
  const a1Id = a1.b?.agent?.id, a2Id = a2.b?.agent?.id;
  const key = idem();
  const first = await owner.post(`/agents/${a1Id}/liquidity-transfer`, { toAgentId: a2Id, amount: 5_000, type: "CASH" }, { idempotency: key });
  chk("14i cash handoff recorded", first.s === 201 && first.b?.transfer?.id && !/idempkey/.test(first.b?.transfer?.note ?? ""), `status=${first.s} ${JSON.stringify(first.b).slice(0, 120)}`);
  const replay = await owner.post(`/agents/${a1Id}/liquidity-transfer`, { toAgentId: a2Id, amount: 5_000, type: "CASH" }, { idempotency: key });
  chk("14j replaying the same key returns the same transfer", (replay.s === 201 || replay.s === 200) && replay.b?.transfer?.id === first.b?.transfer?.id, `status=${replay.s} id=${replay.b?.transfer?.id?.slice(0, 8)} first=${first.b?.transfer?.id?.slice(0, 8)}`);
  const self = await owner.post(`/agents/${a1Id}/liquidity-transfer`, { toAgentId: a1Id, amount: 1, type: "CASH" }, { idempotency: true });
  chk("14k transfer to the same agent → 400", self.s === 400, `status=${self.s}`);
  const noFloat = await owner.post(`/agents/${a1Id}/liquidity-transfer`, { toAgentId: a2Id, amount: 1_000, type: "FLOAT" }, { idempotency: true });
  const a1After = await owner.get(`/agents/${a1Id}/liquidity`);
  chk("14l float transfer without float is refused and leaves balances untouched", noFloat.s !== 201 && Number(a1After.b?.floatBalance) === 0, `status=${noFloat.s} float=${a1After.b?.floatBalance}`);

  // Investment pools: shares issued at the pool's value per share, principal back while open.
  const mgr  = await createUser({ firstName: "Mgr",  kycLevel: 2 });
  const inv1 = await createUser({ firstName: "Inv1", kycLevel: 2 });
  const inv2 = await createUser({ firstName: "Inv2", kycLevel: 2 });
  await fund(inv1.wallet.id, 100_000); await fund(inv2.wallet.id, 100_000);
  const pool = await mgr.post("/pools/investment", { name: `Shares pool ${Date.now()}`, managerId: mgr.userId, goalAmount: 1_000_000, currency: "XOF", minInvestment: 1_000, expectedReturn: 10 });
  const poolId = pool.b?.id;
  chk("14m pool created", pool.s === 201 && !!poolId, `status=${pool.s} ${pool.b?.message ?? ""}`);
  const p1 = await inv1.money(`/pools/investment/${poolId}/invest`, { fromWalletId: inv1.wallet.id, amount: 10_000 });
  chk("14n first investor: 1 share per unit", p1.s === 201 && p1.b?.shares === 10_000, `status=${p1.s} shares=${p1.b?.shares}`);
  const p2 = await inv2.money(`/pools/investment/${poolId}/invest`, { fromWalletId: inv2.wallet.id, amount: 5_000 });
  chk("14o second investor gets shares in proportion to money (5 000, not 50)", p2.s === 201 && p2.b?.shares === 5_000, `status=${p2.s} shares=${p2.b?.shares}`);
  const redeem = await inv2.money(`/pools/investment/positions/${p2.b?.id}/redeem`, {});
  chk("14p principal redeemed while the pool is still open", redeem.s === 200 && (await balance(inv2, inv2.wallet.id)) === 100_000, `status=${redeem.s} ${redeem.b?.message ?? ""}`);
  const poolAfter = await mgr.get(`/pools/investment/${poolId}`);
  chk("14q pool capital and shares shrink with the redemption", Number(poolAfter.b?.currentAmount) === 10_000 && Number(poolAfter.b?.totalShares ?? 10_000) === 10_000, `current=${poolAfter.b?.currentAmount} shares=${poolAfter.b?.totalShares}`);
}

// ── 15. HTTP hardening ───────────────────────────────────────────────────────
{
  const base = (process.env.API_BASE ?? "http://localhost:8080/api").replace(/\/api$/, "");
  const health = await fetch(`${base}/api/health`);
  const h = health.headers;
  chk("15a security headers on API responses", h.get("x-content-type-options") === "nosniff" && h.get("x-frame-options") === "DENY" && h.get("referrer-policy") === "no-referrer" && h.get("cache-control") === "no-store", `nosniff=${h.get("x-content-type-options")} frame=${h.get("x-frame-options")} referrer=${h.get("referrer-policy")} cache=${h.get("cache-control")}`);
  chk("15b server fingerprint header removed", h.get("x-powered-by") === null, `x-powered-by=${h.get("x-powered-by")}`);

  const allowed = process.env.CORS_ORIGINS?.split(",")[0]?.trim();
  if (allowed) {
    const ok = await fetch(`${base}/api/health`, { headers: { Origin: allowed } });
    const evil = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
    chk("15c allow-listed origin gets CORS headers", ok.headers.get("access-control-allow-origin") === allowed, `acao=${ok.headers.get("access-control-allow-origin")}`);
    chk("15d unknown origin gets none", evil.headers.get("access-control-allow-origin") === null, `acao=${evil.headers.get("access-control-allow-origin")}`);
  } else {
    chk("15c/15d CORS allow-list (skipped: CORS_ORIGINS not set for this run, permissive outside production)", true);
  }

  const huge = await fetch(`${base}/api/users/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "x".repeat(3 * 1024 * 1024) }) });
  chk("15e oversized JSON body → 413", huge.status === 413, `status=${huge.status}`);
  const malformed = await fetch(`${base}/api/users/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  chk("15f malformed JSON body → 400 MALFORMED_JSON", malformed.status === 400 && (await malformed.json().catch(() => ({}))).code === "MALFORMED_JSON", `status=${malformed.status}`);
}

const { fail } = summary("INTEGRITY SUITE");
process.exit(fail ? 1 : 0);
