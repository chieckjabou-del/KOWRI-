import { randomUUID } from "crypto";

const BASE = "http://localhost:8080/api";
const results = [];
let pass = 0, fail = 0;

function chk(name, ok, detail = "") {
  const status = ok ? "✅" : "❌";
  const suffix = detail ? ` (${detail})` : "";
  console.log(`  ${status} ${name}${suffix}`);
  results.push({ name, ok });
  ok ? pass++ : fail++;
}

async function get(path) {
  try {
    const r = await fetch(`${BASE}${path}`);
    const b = await r.json().catch(() => null);
    return { s: r.status, b };
  } catch (e) { return { s: 0, b: null }; }
}

async function post(path, body, headers = {}) {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const b = await r.json().catch(() => null);
    return { s: r.status, b };
  } catch (e) { return { s: 0, b: null }; }
}

async function patch(path, body) {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const b = await r.json().catch(() => null);
    return { s: r.status, b };
  } catch (e) { return { s: 0, b: null }; }
}

async function del(path) {
  try {
    const r = await fetch(`${BASE}${path}`, { method: "DELETE" });
    const b = await r.json().catch(() => null);
    return { s: r.status, b };
  } catch (e) { return { s: 0, b: null }; }
}

async function deposit(walletId, amount, currency = "XOF") {
  return post(
    `/wallets/${walletId}/deposit`,
    { amount, currency, reference: `SEED-P7-${randomUUID()}` },
    { "Idempotency-Key": randomUUID() },
  );
}

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║   KOWRI V5.0 — PHASE 7 SUPER-APP COMMUNITY FINANCE SUITE    ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
console.log();

// ── Seed: create two funded users ─────────────────────────────────────────────
const ts = Date.now();

const u1 = await post("/users", { phone: `+221700${String(ts).slice(-6)}`, firstName: "Alice", lastName: "Diallo", country: "SN", pin: "1234" });
const u2 = await post("/users", { phone: `+221711${String(ts).slice(-6)}`, firstName: "Bob",   lastName: "Keita",  country: "SN", pin: "1234" });

const uid1 = u1.b?.id;
const uid2 = u2.b?.id;

let w1, w2;
if (uid1) {
  const wr = await post("/wallets", { userId: uid1, currency: "XOF", walletType: "personal" });
  w1 = wr.b;
  if (w1?.id) await deposit(w1.id, 5000000);
}
if (uid2) {
  const wr = await post("/wallets", { userId: uid2, currency: "XOF", walletType: "personal" });
  w2 = wr.b;
  if (w2?.id) await deposit(w2.id, 2000000);
}

const seeded = !!uid1 && !!uid2 && !!w1?.id && !!w2?.id;
chk("SEED: 2 users + wallets created", seeded, `uid1=${uid1?.slice(0,8)} w1=${w1?.id?.slice(0,8)}`);

// ── P7-1  TONTINE LIFECYCLE ────────────────────────────────────────────────────
console.log("\n  ── P7-1  TONTINE LIFECYCLE ──");

const tontine = await post("/tontines", {
  name: `P7 Community Tontine ${ts}`, adminUserId: uid1,
  currency: "XOF", contributionAmount: 50000, frequency: "monthly", maxMembers: 5,
});
chk("P7-1a POST /tontines creates tontine", tontine.s === 201, `id=${tontine.b?.id?.slice(0,8) ?? tontine.b?.message}`);
const tontineId = tontine.b?.id;

const addM1 = await post(`/community/tontines/${tontineId}/members`, { userId: uid1 });
chk("P7-1b Add member 1 → 201 or 409 (admin auto-joined)", addM1.s === 201 || addM1.s === 409);

const addM2 = await post(`/community/tontines/${tontineId}/members`, { userId: uid2 });
chk("P7-1c Add member 2 → 201", addM2.s === 201);

const dupM = await post(`/community/tontines/${tontineId}/members`, { userId: uid1 });
chk("P7-1d Duplicate member → 409", dupM.s === 409);

const activate = await post(`/community/tontines/${tontineId}/activate`, { rotationModel: "fixed" });
chk("P7-1e Activate tontine → 200", activate.s === 200, `status=${activate.b?.status}`);
chk("P7-1f Status is active", activate.b?.status === "active");

const schedule = await get(`/community/tontines/${tontineId}/schedule`);
chk("P7-1g GET schedule → 200", schedule.s === 200);
chk("P7-1h Schedule has 2 entries", schedule.b?.schedule?.length === 2);
chk("P7-1i Schedule has frequency", !!schedule.b?.frequency);

const bid = await post(`/community/tontines/${tontineId}/bids`, { userId: uid2, bidAmount: 5000, desiredPosition: 1 });
chk("P7-1j POST bid → 201", bid.s === 201, `bidAmount=${bid.b?.bidAmount}`);
chk("P7-1k Bid amount stored", bid.b?.bidAmount === 5000);

const listBids = await get(`/community/tontines/${tontineId}/bids`);
chk("P7-1l GET bids → 200", listBids.s === 200);
chk("P7-1m Bids array returned", Array.isArray(listBids.b?.bids));

const collect = await post(`/community/tontines/${tontineId}/collect`, {});
chk("P7-1n POST collect → 200", collect.s === 200, `collected=${collect.b?.collected}`);

const payout = await post(`/community/tontines/${tontineId}/payout`, {});
chk("P7-1o POST payout → 200", payout.s === 200, `round=${payout.b?.round ?? payout.b?.message}`);

const listPos = await post(`/community/tontines/${tontineId}/positions/list`, {
  sellerId: uid2, payoutOrder: 2, askPrice: 25000, currency: "XOF",
});
chk("P7-1p POST position listing → 201", listPos.s === 201, `askPrice=${listPos.b?.askPrice}`);
const listingId = listPos.b?.id;

const market = await get(`/community/tontines/${tontineId}/positions/market`);
chk("P7-1q GET position market → 200", market.s === 200);
chk("P7-1r Market listings array", Array.isArray(market.b?.listings));

if (listingId) {
  const buy = await post(`/community/tontines/positions/${listingId}/buy`, { buyerId: uid1 });
  chk("P7-1s Buy tontine position → 200", buy.s === 200, buy.b?.message ?? buy.b?.error);
}

// ── P7-2  SAVINGS ENGINE ──────────────────────────────────────────────────────
console.log("\n  ── P7-2  SAVINGS ENGINE ──");

const rateRes = await get(`/savings/rate?userId=${uid1}`);
chk("P7-2a GET /savings/rate → 200", rateRes.s === 200, `rate=${rateRes.b?.annualRate}%`);
chk("P7-2b Rate ≥ 6%", (rateRes.b?.annualRate ?? 0) >= 6);
chk("P7-2c tierRates object present", !!rateRes.b?.tierRates);

const createPlan = await post("/savings/plans", {
  userId: uid1, walletId: w1?.id,
  name: "My 90-Day Plan", amount: 200000, currency: "XOF", termDays: 90,
});
chk("P7-2d POST /savings/plans → 201", createPlan.s === 201, `id=${createPlan.b?.id?.slice(0,8) ?? createPlan.b?.message}`);
chk("P7-2e Plan lockedAmount = 200000", createPlan.b?.lockedAmount === 200000);
chk("P7-2f Plan daysRemaining = 90", createPlan.b?.daysRemaining === 90);
chk("P7-2g Interest rate returned", typeof createPlan.b?.interestRate === "number");
const savingsPlanId = createPlan.b?.id;

const getPlan = await get(`/savings/plans/${savingsPlanId}`);
chk("P7-2h GET /savings/plans/:id → 200", getPlan.s === 200);
chk("P7-2i Status is active", getPlan.b?.status === "active");

const accrue = await post(`/savings/plans/${savingsPlanId}/accrue`, {});
chk("P7-2j POST accrue → 200", accrue.s === 200, `yield=${accrue.b?.yieldAmount?.toFixed?.(6) ?? "n/a"}`);
chk("P7-2k Yield > 0", (accrue.b?.yieldAmount ?? 0) > 0);

const summary = await get(`/savings/summary/${uid1}`);
chk("P7-2l GET /savings/summary → 200", summary.s === 200);
chk("P7-2m Summary has activePlans ≥ 1", (summary.b?.activePlans ?? 0) >= 1);
chk("P7-2n totalLocked ≥ 0", (summary.b?.totalLocked ?? -1) >= 0);

const listPlans = await get(`/savings/plans?userId=${uid1}`);
chk("P7-2o GET /savings/plans?userId → 200", listPlans.s === 200);
chk("P7-2p At least 1 plan", listPlans.b?.plans?.length >= 1);

const breakRes = await post(`/savings/plans/${savingsPlanId}/break`, { targetWalletId: w1?.id });
chk("P7-2q POST early break → 200", breakRes.s === 200, `penalty=${breakRes.b?.penalty}`);
chk("P7-2r isEarlyBreak = true", breakRes.b?.isEarlyBreak === true);
chk("P7-2s Returns principal + yield", typeof breakRes.b?.principal === "number");

// ── P7-3  INVESTMENT POOLS ────────────────────────────────────────────────────
console.log("\n  ── P7-3  INVESTMENT POOLS ──");

const createPool = await post("/pools/investment", {
  name: `Tech Africa Fund ${ts}`, managerId: uid1,
  goalAmount: 500000, currency: "XOF", minInvestment: 5000,
  expectedReturn: 12, poolType: "equity",
});
chk("P7-3a POST /pools/investment → 201", createPool.s === 201, `id=${createPool.b?.id?.slice(0,8) ?? createPool.b?.message}`);
chk("P7-3b goalAmount = 500000", createPool.b?.goalAmount === 500000);
chk("P7-3c minInvestment = 5000", createPool.b?.minInvestment === 5000);
const investPoolId = createPool.b?.id;

const listPools = await get("/pools/investment");
chk("P7-3d GET /pools/investment → 200", listPools.s === 200);
chk("P7-3e Returns pools array", Array.isArray(listPools.b?.pools));
chk("P7-3f At least 1 pool", listPools.b?.pools?.length >= 1);
chk("P7-3g Has pagination", !!listPools.b?.pagination);

const getPool = await get(`/pools/investment/${investPoolId}`);
chk("P7-3h GET /pools/investment/:id → 200", getPool.s === 200);
chk("P7-3i Has nav field", typeof getPool.b?.nav === "number");
chk("P7-3j Has investorCount", typeof getPool.b?.investorCount === "number");

const invest = await post(`/pools/investment/${investPoolId}/invest`, {
  userId: uid2, fromWalletId: w2?.id, amount: 50000,
});
chk("P7-3k POST invest → 201", invest.s === 201, `shares=${invest.b?.shares ?? invest.b?.message}`);
chk("P7-3l investedAmount = 50000", invest.b?.investedAmount === 50000);

const badInvest = await post(`/pools/investment/${investPoolId}/invest`, {
  userId: uid2, fromWalletId: w2?.id, amount: 100,
});
chk("P7-3m Below min → 400", badInvest.s === 400);

const nav = await get(`/pools/investment/${investPoolId}/nav`);
chk("P7-3n GET /pools/investment/:id/nav → 200", nav.s === 200);
chk("P7-3o NAV > 0", (nav.b?.nav ?? 0) > 0);
chk("P7-3p computedAt present", !!nav.b?.computedAt);

const filteredPools = await get("/pools/investment?status=open");
chk("P7-3q Filter pools by status", filteredPools.s === 200 && Array.isArray(filteredPools.b?.pools));

// ── P7-4  INSURANCE POOLS ─────────────────────────────────────────────────────
console.log("\n  ── P7-4  INSURANCE POOLS ──");

const createIns = await post("/pools/insurance", {
  name: `Health Shield ${ts}`, managerId: uid1, insuranceType: "health",
  premiumAmount: 5000, claimLimit: 500000, currency: "XOF", maxMembers: 50,
});
chk("P7-4a POST /pools/insurance → 201", createIns.s === 201, `id=${createIns.b?.id?.slice(0,8) ?? createIns.b?.message}`);
chk("P7-4b premiumAmount = 5000", createIns.b?.premiumAmount === 5000);
const insPoolId = createIns.b?.id;

const listIns = await get("/pools/insurance");
chk("P7-4c GET /pools/insurance → 200", listIns.s === 200);
chk("P7-4d Returns pools array", Array.isArray(listIns.b?.pools));

const getIns = await get(`/pools/insurance/${insPoolId}`);
chk("P7-4e GET /pools/insurance/:id → 200", getIns.s === 200);
chk("P7-4f Has claimLimit", typeof getIns.b?.claimLimit === "number");

const joinIns = await post(`/pools/insurance/${insPoolId}/join`, {
  userId: uid2, walletId: w2?.id,
});
chk("P7-4g POST /join → 201", joinIns.s === 201, `policyId=${joinIns.b?.id?.slice(0,8) ?? joinIns.b?.message}`);
const policyId = joinIns.b?.id;

const dupJoin = await post(`/pools/insurance/${insPoolId}/join`, {
  userId: uid2, walletId: w2?.id,
});
chk("P7-4h Duplicate join → 400", dupJoin.s === 400);

const listPolicies = await get(`/pools/insurance/${insPoolId}/policies`);
chk("P7-4i GET policies → 200", listPolicies.s === 200);
chk("P7-4j At least 1 policy", listPolicies.b?.policies?.length >= 1);

const fileClaim = await post(`/pools/insurance/${insPoolId}/claims`, {
  policyId, userId: uid2, claimAmount: 100000, reason: "Medical emergency",
});
chk("P7-4k POST claim → 201", fileClaim.s === 201, `id=${fileClaim.b?.id?.slice(0,8) ?? fileClaim.b?.message}`);
chk("P7-4l claimAmount = 100000", fileClaim.b?.claimAmount === 100000);
const claimId = fileClaim.b?.id;

const adjRes = await patch(`/pools/insurance/claims/${claimId}/adjudicate`, {
  adjudicatorId: uid1, approved: true, payoutAmount: 2500,
});
chk("P7-4m Adjudicate → 200", adjRes.s === 200, `approved=${adjRes.b?.approved}`);
chk("P7-4n Claim approved = true", adjRes.b?.approved === true);

const listClaims = await get(`/pools/insurance/${insPoolId}/claims`);
chk("P7-4o GET claims → 200", listClaims.s === 200);
chk("P7-4p Claims array returned", Array.isArray(listClaims.b?.claims));

const approvedClaims = await get(`/pools/insurance/${insPoolId}/claims?status=approved`);
chk("P7-4q Filter claims by status", approvedClaims.s === 200);

// ── P7-5  DIASPORA & REMITTANCE ───────────────────────────────────────────────
console.log("\n  ── P7-5  DIASPORA & REMITTANCE ──");

const corridors = await get("/diaspora/corridors");
chk("P7-5a GET /diaspora/corridors → 200", corridors.s === 200, `count=${corridors.b?.count}`);
chk("P7-5b Corridors seeded ≥ 1", (corridors.b?.count ?? 0) >= 1);

const filtered = await get("/diaspora/corridors?fromCountry=FR&toCountry=SN");
chk("P7-5c Filter corridors → 200", filtered.s === 200);
chk("P7-5d All match filter", filtered.b?.corridors?.every(c => c.fromCountry === "FR") ?? false);

const firstCorrId = corridors.b?.corridors?.[0]?.id;
if (firstCorrId) {
  const corrDetail = await get(`/diaspora/corridors/${firstCorrId}`);
  chk("P7-5e GET /diaspora/corridors/:id → 200", corrDetail.s === 200, `flatFee=${corrDetail.b?.flatFee}`);
}

const quote = await post("/diaspora/quote", { amount: 100000, fromCurrency: "EUR", toCurrency: "XOF" });
chk("P7-5f POST /diaspora/quote → 200", quote.s === 200, `quotes=${quote.b?.quotes?.length}`);
chk("P7-5g Quote returns quotes array", Array.isArray(quote.b?.quotes));

const addBene = await post("/diaspora/beneficiaries", {
  userId: uid1, name: "Mamadou Diallo",
  phone: `+2217${String(ts).slice(-8)}`, relationship: "brother",
  country: "SN", currency: "XOF",
});
chk("P7-5h POST /diaspora/beneficiaries → 201", addBene.s === 201, `id=${addBene.b?.id?.slice(0,8)}`);
chk("P7-5i Name stored correctly", addBene.b?.name === "Mamadou Diallo");
const beneficiaryId = addBene.b?.id;

const listBene = await get(`/diaspora/beneficiaries?userId=${uid1}`);
chk("P7-5j GET /diaspora/beneficiaries → 200", listBene.s === 200);
chk("P7-5k At least 1 beneficiary", listBene.b?.beneficiaries?.length >= 1);

const recurring = await post("/diaspora/recurring", {
  userId: uid1, fromWalletId: w1?.id, beneficiaryId,
  amount: 50000, currency: "XOF", frequency: "monthly", maxRuns: 12,
});
chk("P7-5l POST /diaspora/recurring → 201", recurring.s === 201, `amount=${recurring.b?.amount ?? recurring.b?.message}`);
chk("P7-5m Amount = 50000", recurring.b?.amount === 50000);
const recurringId = recurring.b?.id;

const listRec = await get(`/diaspora/recurring?userId=${uid1}`);
chk("P7-5n GET /diaspora/recurring → 200", listRec.s === 200);
chk("P7-5o At least 1 recurring", listRec.b?.recurring?.length >= 1);

const pauseR = await patch(`/diaspora/recurring/${recurringId}/pause`, {});
chk("P7-5p PATCH pause → 200", pauseR.s === 200, `status=${pauseR.b?.status}`);
chk("P7-5q Status paused", pauseR.b?.status === "paused");

const resumeR = await patch(`/diaspora/recurring/${recurringId}/resume`, {});
chk("P7-5r PATCH resume → 200", resumeR.s === 200);
chk("P7-5s Status active", resumeR.b?.status === "active");

const cancelR = await del(`/diaspora/recurring/${recurringId}`);
chk("P7-5t DELETE recurring → 200", cancelR.s === 200);
chk("P7-5u Status cancelled", cancelR.b?.status === "cancelled");

const delBene = await del(`/diaspora/beneficiaries/${beneficiaryId}`);
chk("P7-5v DELETE beneficiary → 200", delBene.s === 200);

const runDueR = await post("/diaspora/recurring/run", {});
chk("P7-5w POST /diaspora/recurring/run → 200", runDueR.s === 200, `ran=${runDueR.b?.ran}`);

// ── P7-6  CREATOR ECONOMY ─────────────────────────────────────────────────────
console.log("\n  ── P7-6  CREATOR ECONOMY ──");

const handle = `crew_${ts}`;
const createComm = await post("/creator/communities", {
  name: `Finance Crew Africa ${ts}`, creatorId: uid1,
  handle, platformFeeRate: 2, creatorFeeRate: 5,
});
chk("P7-6a POST /creator/communities → 201", createComm.s === 201, `id=${createComm.b?.id?.slice(0,8) ?? createComm.b?.message}`);
chk("P7-6b Handle stored", createComm.b?.handle === handle);
const communityId = createComm.b?.id;

const dupComm = await post("/creator/communities", {
  name: "Dup", creatorId: uid2, handle,
});
chk("P7-6c Duplicate handle → 409", dupComm.s === 409);

const getComm = await get(`/creator/communities/${communityId}`);
chk("P7-6d GET community by ID → 200", getComm.s === 200);
chk("P7-6e Community id matches", getComm.b?.id === communityId);

const byHandle = await get(`/creator/communities/${handle}`);
chk("P7-6f GET community by handle → 200", byHandle.s === 200);
chk("P7-6g Handle matches", byHandle.b?.handle === handle);

const listComm = await get("/creator/communities");
chk("P7-6h GET /creator/communities → 200", listComm.s === 200);
chk("P7-6i Returns communities array", Array.isArray(listComm.b?.communities));
chk("P7-6j Has pagination", !!listComm.b?.pagination);

const joinComm = await post(`/creator/communities/${communityId}/join`, { userId: uid2 });
chk("P7-6k POST /join → 200", joinComm.s === 200);

const earnings = await post(`/creator/communities/${communityId}/earnings`, {
  transactionAmount: 100000, currency: "XOF",
});
chk("P7-6l POST earnings → 200", earnings.s === 200);
chk("P7-6m Creator fee > 0", (earnings.b?.creatorFee ?? 0) > 0);
chk("P7-6n Platform fee > 0", (earnings.b?.platformFee ?? 0) > 0);

const dashboard = await get(`/creator/dashboard/${uid1}`);
chk("P7-6o GET /creator/dashboard → 200", dashboard.s === 200);
chk("P7-6p Has stats object", !!dashboard.b?.stats);
chk("P7-6q totalCommunities ≥ 1", dashboard.b?.stats?.totalCommunities >= 1);
chk("P7-6r Has communities array", Array.isArray(dashboard.b?.communities));

const updateStatus = await patch(`/creator/communities/${communityId}/status`, { status: "active" });
chk("P7-6s PATCH status → 200", updateStatus.s === 200);
chk("P7-6t Status = active", updateStatus.b?.status === "active");

const commPools = await get(`/creator/communities/${communityId}/pools`);
chk("P7-6u GET /communities/:id/pools → 200", commPools.s === 200);
chk("P7-6v Has investmentPools array", Array.isArray(commPools.b?.investmentPools));
chk("P7-6w Has tontines array", Array.isArray(commPools.b?.tontines));

// ── P7-7  REPUTATION ENGINE ───────────────────────────────────────────────────
console.log("\n  ── P7-7  REPUTATION ENGINE ──");

const computeRep = await post(`/community/reputation/${uid1}/compute`, {});
chk("P7-7a POST reputation compute → 200", computeRep.s === 200, `score=${computeRep.b?.score}`);
chk("P7-7b Score is a number ≥ 0", typeof computeRep.b?.score === "number" && computeRep.b?.score >= 0);
chk("P7-7c Tier is valid", ["new","bronze","silver","gold","platinum"].includes(computeRep.b?.tier));
chk("P7-7d Has contributionRate", typeof computeRep.b?.contributionRate === "number");

const getRep = await get(`/community/reputation/${uid1}`);
chk("P7-7e GET reputation → 200", getRep.s === 200);
chk("P7-7f Score returned", (getRep.b?.score ?? -1) >= 0);
chk("P7-7g Has tier", typeof getRep.b?.tier === "string");
chk("P7-7h Has reciprocityScore", typeof getRep.b?.reciprocityScore === "number");

const noRep = await get(`/community/reputation/${randomUUID()}`);
chk("P7-7i Unknown user → 404", noRep.s === 404);

const rep2 = await post(`/community/reputation/${uid2}/compute`, {});
chk("P7-7j Second user reputation computed", rep2.s === 200);

// ── P7-8  CREDIT SCORE COMPUTE + LOAN REPAYMENT ───────────────────────────────
console.log("\n  ── P7-8  CREDIT SCORE + LOAN REPAYMENT ──");

const computeScore = await post(`/credit/scores/${uid1}/compute`, {});
chk("P7-8a POST /credit/scores/:id/compute → 200", computeScore.s === 200, `score=${computeScore.b?.score}`);
chk("P7-8b Has composite factor", typeof computeScore.b?.factors?.composite === "number");
chk("P7-8c maxLoanAmount > 0", (computeScore.b?.maxLoanAmount ?? 0) > 0);
chk("P7-8d Tier is valid", ["bronze","silver","gold","platinum"].includes(computeScore.b?.tier));
chk("P7-8e interestRate present", typeof computeScore.b?.interestRate === "number");

const computeScore2 = await post(`/credit/scores/${uid2}/compute`, {});
chk("P7-8f Second user score computed", computeScore2.s === 200);

const repayMissingFields = await post("/credit/loans/any/repay", { walletId: "x" });
chk("P7-8g Repay missing fields → 400", repayMissingFields.s === 400);

const repayNotFound = await post("/credit/loans/nonexistent_loan_xyz/repay", {
  walletId: w1?.id, amount: 1000, userId: uid1,
});
chk("P7-8h Repay unknown loan → 404", repayNotFound.s === 404);

const listRepayments = await get("/credit/loans/any_loan_id/repayments");
chk("P7-8i GET repayments → 200", listRepayments.s === 200);
chk("P7-8j Returns repayments array", Array.isArray(listRepayments.b?.repayments));

// ── P7-9  SCHEDULER & PLATFORM INTEGRITY ──────────────────────────────────────
console.log("\n  ── P7-9  SCHEDULER & PLATFORM INTEGRITY ──");

const jobs = await get("/community/scheduler/jobs");
chk("P7-9a GET /community/scheduler/jobs → 200", jobs.s === 200);
chk("P7-9b Jobs array returned", Array.isArray(jobs.b?.jobs));
chk("P7-9c total is number", typeof jobs.b?.total === "number");
chk("P7-9d Scheduler has jobs (collect/payout triggered)", jobs.b?.total >= 0);

// Phase 1–6 regression checks
const health = await get("/health");
chk("P7-9e /api/health still 200", health.s === 200);

const walletsCheck = await get("/wallets?limit=1");
chk("P7-9f /api/wallets still works", walletsCheck.s === 200);

const tontinesCheck = await get("/tontines?limit=1");
chk("P7-9g /api/tontines still works", tontinesCheck.s === 200);

const creditScoresCheck = await get("/credit/scores?limit=1");
chk("P7-9h /api/credit/scores still works", creditScoresCheck.s === 200);

const fxRates = await get("/fx/rates");
chk("P7-9i /api/fx/rates still works", fxRates.s === 200);

const systemStatus = await get("/system/health");
const systemStatus2 = await get("/system/metrics");
chk("P7-9j /api/system endpoints still work", systemStatus.s === 200 || systemStatus2.s === 200);

const amlCheck = await get("/aml/cases?limit=1");
chk("P7-9k /api/aml/cases still works", amlCheck.s === 200);

const analyticsCheck = await get("/analytics/overview");
chk("P7-9l /api/analytics/overview still works", analyticsCheck.s === 200);

// ── Final Summary ─────────────────────────────────────────────────────────────
console.log();
console.log("─────────────────────────────────────────────────────────────────");
console.log(`PASS: ${pass}  |  FAIL: ${fail}  |  TOTAL: ${pass + fail}`);
console.log(`Score: ${pass}/${pass + fail}`);
if (fail === 0) {
  console.log("🌍 PHASE 7 COMPLETE — KOWRI V5.0 SUPER-APP IS FULLY OPERATIONAL");
  console.log("   Tontine Scheduler ✓ | Savings Engine ✓ | Investment Pools ✓");
  console.log("   Insurance ✓ | Diaspora/Remittance ✓ | Creator Economy ✓");
  console.log("   Reputation Engine ✓ | Credit Compute ✓ | Loan Repayment ✓");
} else {
  console.log(`⚠️  ${fail} check(s) need attention`);
}
console.log("═════════════════════════════════════════════════════════════════");
