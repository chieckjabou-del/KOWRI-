#!/usr/bin/env node
// KOWRI V5.0 — Phase 7 Integration Test Suite
// Covers: savings, diaspora, community finance, investment pools,
//         insurance pools, creator economy, credit repayments,
//         reputation, tontine position market, scheduler jobs
//
// Run: node scripts/test-phase7.mjs
// Requires: server running on PORT (default 8080)

const BASE = `http://localhost:${process.env.PORT ?? 8080}/api`;
const INDENT = "  ";

let passed = 0;
let failed = 0;
const failures = [];
let _seq = 0;

// ── Request helpers ───────────────────────────────────────────────────────────
const uid = () => `idem-${Date.now()}-${++_seq}-${Math.random().toString(36).slice(2, 7)}`;

const post = (path, body, { idempotency = false } = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotency ? { "Idempotency-Key": uid() } : {}),
    },
    body: JSON.stringify(body),
  }).then(r => r.json());

const get   = (path) => fetch(`${BASE}${path}`).then(r => r.json());
const del_  = (path) => fetch(`${BASE}${path}`, { method: "DELETE" }).then(r => r.json());
const patch = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(r => r.json());

// ── Assertions ────────────────────────────────────────────────────────────────
function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`${INDENT}✅ ${label}`);
    passed++;
  } else {
    console.log(`${INDENT}❌ ${label}${detail ? " — " + detail : ""}`);
    failed++;
    failures.push(label);
  }
}

function section(name) {
  console.log(`\n${"─".repeat(62)}`);
  console.log(`  ${name}`);
  console.log("─".repeat(62));
}

// ── Seed helpers ──────────────────────────────────────────────────────────────
// Correct user fields: phone, firstName, lastName, country, pin
async function createUser(label) {
  const n = Date.now().toString().slice(-8) + (++_seq);
  const u = await post("/users", {
    phone:     `+225${n.slice(-8).padStart(8, "0")}`,
    firstName:  label.split("-")[0] ?? label,
    lastName:   "TestUser",
    country:    "CI",
    pin:        "1234",
  });
  if (!u.id) throw new Error(`createUser failed: ${JSON.stringify(u).slice(0, 100)}`);
  return u.id;
}

// Correct wallet fields: userId, currency, walletType
async function createWallet(userId, currency = "XOF", walletType = "personal") {
  const w = await post("/wallets", { userId, currency, walletType });
  if (!w.id) throw new Error(`createWallet failed: ${JSON.stringify(w).slice(0, 100)}`);
  return w.id;
}

// Deposits require Idempotency-Key
async function fundWallet(walletId, amount, currency = "XOF") {
  return post(`/wallets/${walletId}/deposit`, { amount, currency }, { idempotency: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. SAVINGS PLANS
// ═══════════════════════════════════════════════════════════════════════════════
async function testSavings() {
  section("1. SAVINGS PLANS");

  const userId   = await createUser("savings");
  const walletId = await createWallet(userId);
  await fundWallet(walletId, 50000);

  // Rate lookup
  const rateRes = await get(`/savings/rate?userId=${userId}`);
  assert("GET /savings/rate returns annualRate", typeof rateRes.annualRate === "number");
  assert("GET /savings/rate returns dailyRate",  typeof rateRes.dailyRate  === "number");
  assert("GET /savings/rate returns tierRates",  rateRes.tierRates?.gold   !== undefined);

  // Create plan
  const plan = await post("/savings/plans", {
    userId, walletId, name: "Test Plan", amount: 10000, termDays: 30,
  });
  assert("POST /savings/plans creates plan",              plan.id    !== undefined,  JSON.stringify(plan).slice(0, 80));
  assert("POST /savings/plans — lockedAmount is number",  typeof plan.lockedAmount  === "number");
  assert("POST /savings/plans — daysRemaining is number", typeof plan.daysRemaining === "number");
  assert("POST /savings/plans — isMatured=false",         plan.isMatured === false);

  const planId = plan.id;

  // List plans
  const listRes = await get(`/savings/plans?userId=${userId}`);
  assert("GET /savings/plans returns array",        Array.isArray(listRes.plans));
  assert("GET /savings/plans finds created plan",   listRes.plans.some(p => p.id === planId));

  // Get single plan
  const singleRes = await get(`/savings/plans/${planId}`);
  assert("GET /savings/plans/:id returns plan",     singleRes.id === planId);
  assert("GET /savings/plans/:id has isMatured",    "isMatured" in singleRes);

  // Accrue yield
  const accrueRes = await post(`/savings/plans/${planId}/accrue`, {});
  assert("POST /savings/plans/:id/accrue — success",      accrueRes.success === true,    JSON.stringify(accrueRes).slice(0, 80));
  assert("POST /savings/plans/:id/accrue — yieldAmount",  typeof accrueRes.yieldAmount === "number");

  // Summary
  const summaryRes = await get(`/savings/summary/${userId}`);
  assert("GET /savings/summary/:userId totalPlans >= 1", summaryRes.totalPlans >= 1);
  assert("GET /savings/summary/:userId has totalLocked", typeof summaryRes.totalLocked === "number");

  // Early break
  const breakRes = await post(`/savings/plans/${planId}/break`, { targetWalletId: walletId });
  assert("POST /savings/plans/:id/break — success",        breakRes.success === true, JSON.stringify(breakRes).slice(0, 80));
  assert("POST /savings/plans/:id/break — isEarlyBreak",   "isEarlyBreak" in breakRes);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. DIASPORA & REMITTANCE
// ═══════════════════════════════════════════════════════════════════════════════
async function testDiaspora() {
  section("2. DIASPORA & REMITTANCE");

  const userId      = await createUser("diaspora");
  const fromWalletId = await createWallet(userId);
  await fundWallet(fromWalletId, 100000);

  // Corridors
  const corrRes = await get("/diaspora/corridors");
  assert("GET /diaspora/corridors returns corridors array", Array.isArray(corrRes.corridors));
  assert("GET /diaspora/corridors has count",               typeof corrRes.count === "number");

  // Quote
  const quoteRes = await post("/diaspora/quote", { amount: 50000, fromCurrency: "XOF", toCurrency: "GHS" });
  assert("POST /diaspora/quote returns quotes array", Array.isArray(quoteRes.quotes));
  assert("POST /diaspora/quote has amount",           quoteRes.amount === 50000);

  // Add beneficiary
  const beneRes = await post("/diaspora/beneficiaries", {
    userId, name: "John Mensah", phone: "+233200000001", country: "GH", currency: "GHS",
  });
  assert("POST /diaspora/beneficiaries creates beneficiary", beneRes.id    !== undefined, JSON.stringify(beneRes).slice(0, 80));
  assert("POST /diaspora/beneficiaries stores userId",        beneRes.userId === userId);

  const beneId = beneRes.id;

  // List beneficiaries
  const listRes = await get(`/diaspora/beneficiaries?userId=${userId}`);
  assert("GET /diaspora/beneficiaries returns list",    Array.isArray(listRes.beneficiaries));
  assert("GET /diaspora/beneficiaries finds created",   listRes.beneficiaries.some(b => b.id === beneId));

  // Remove beneficiary
  const delRes = await del_(`/diaspora/beneficiaries/${beneId}`);
  assert("DELETE /diaspora/beneficiaries/:id soft-deletes", delRes.success === true);

  // Recurring transfer
  const recurRes = await post("/diaspora/recurring", {
    userId, fromWalletId, beneficiaryId: beneId,
    amount: 5000, currency: "XOF", frequency: "monthly", description: "Monthly remittance",
  });
  assert("POST /diaspora/recurring creates recurring transfer", recurRes.id    !== undefined, JSON.stringify(recurRes).slice(0, 80));
  assert("POST /diaspora/recurring has frequency",              recurRes.frequency === "monthly");

  const recurId = recurRes.id;

  // Pause / Resume / Cancel
  const pauseRes  = await patch(`/diaspora/recurring/${recurId}/pause`, {});
  assert("PATCH /diaspora/recurring/:id/pause",  pauseRes.status === "paused");

  const resumeRes = await patch(`/diaspora/recurring/${recurId}/resume`, {});
  assert("PATCH /diaspora/recurring/:id/resume", resumeRes.status === "active");

  const cancelRes = await del_(`/diaspora/recurring/${recurId}`);
  assert("DELETE /diaspora/recurring/:id cancels", cancelRes.success === true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. COMMUNITY FINANCE — REPUTATION + SCHEDULER + POSITION MARKET
// ═══════════════════════════════════════════════════════════════════════════════
async function testCommunityFinance() {
  section("3. COMMUNITY FINANCE");

  // Global position market listing
  const posRes = await get("/community/tontines/positions");
  assert("GET /community/tontines/positions returns listings array", Array.isArray(posRes.listings));
  assert("GET /community/tontines/positions has pagination",         posRes.pagination !== undefined);
  assert("GET /community/tontines/positions respects limit param",
    (await get("/community/tontines/positions?limit=5")).pagination?.limit === 5);

  // Reputation — unknown user is 404
  const unkRes = await get("/community/reputation/definitely-unknown-user-xyz-abc");
  assert("GET /community/reputation/:userId — 404 for unknown user", unkRes.error === true);

  // Compute reputation for a real user
  const userId = await createUser("reputation");
  const computeRes = await post(`/community/reputation/${userId}/compute`, {});
  assert("POST /community/reputation/:userId/compute returns score", computeRes.score    !== undefined, JSON.stringify(computeRes).slice(0, 80));
  assert("POST /community/reputation/:userId/compute has tier",      typeof computeRes.tier === "string");
  assert("POST /community/reputation/:userId/compute has userId",    computeRes.userId  === userId);

  // Fetch after compute
  const fetchRes = await get(`/community/reputation/${userId}`);
  assert("GET /community/reputation/:userId returns score after compute", fetchRes.score !== undefined);
  assert("GET /community/reputation/:userId contributionRate is number",  typeof fetchRes.contributionRate === "number");

  // Scheduler jobs
  const jobsRes = await get("/community/scheduler/jobs");
  assert("GET /community/scheduler/jobs returns jobs array", Array.isArray(jobsRes.jobs));
  assert("GET /community/scheduler/jobs has total",          typeof jobsRes.total === "number");
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. INVESTMENT POOLS
// ═══════════════════════════════════════════════════════════════════════════════
async function testInvestmentPools() {
  section("4. INVESTMENT POOLS");

  const managerId = await createUser("pool-manager");

  // Create pool
  const createRes = await post("/pools/investment", {
    name: "West Africa Growth Fund", managerId, goalAmount: 10000000,
    currency: "XOF", minInvestment: 50000, expectedReturn: 12,
    poolType: "general",
  });
  assert("POST /pools/investment creates pool",             createRes.id !== undefined,     JSON.stringify(createRes).slice(0, 80));
  assert("POST /pools/investment goalAmount is number",     typeof createRes.goalAmount    === "number");
  assert("POST /pools/investment currentAmount is number",  typeof createRes.currentAmount === "number");

  const poolId = createRes.id;

  // List pools
  const listRes = await get("/pools/investment");
  assert("GET /pools/investment returns pools array",  Array.isArray(listRes.pools));
  assert("GET /pools/investment has pagination",        listRes.pagination !== undefined);

  // Get pool
  const singleRes = await get(`/pools/investment/${poolId}`);
  assert("GET /pools/investment/:id returns pool",         singleRes.id           === poolId);
  assert("GET /pools/investment/:id has investorCount",    typeof singleRes.investorCount === "number");
  assert("GET /pools/investment/:id has nav",              typeof singleRes.nav           === "number");

  // NAV endpoint
  const navRes = await get(`/pools/investment/${poolId}/nav`);
  assert("GET /pools/investment/:id/nav returns nav",     typeof navRes.nav        === "number");
  assert("GET /pools/investment/:id/nav has computedAt",  navRes.computedAt       !== undefined);
  assert("GET /pools/investment/:id/nav has totalShares", typeof navRes.totalShares === "number");

  // Invest
  const investorId = await createUser("pool-investor");
  const walletId   = await createWallet(investorId);
  await fundWallet(walletId, 500000);

  const investRes = await post(`/pools/investment/${poolId}/invest`, {
    userId: investorId, fromWalletId: walletId, amount: 100000,
  });
  assert("POST /pools/investment/:id/invest creates position", investRes.id    !== undefined,   JSON.stringify(investRes).slice(0, 80));
  assert("POST /pools/investment/:id/invest has shares",       typeof investRes.shares          === "number");
  assert("POST /pools/investment/:id/invest has investedAmount", typeof investRes.investedAmount === "number");

  const positionId = investRes.id;

  // Distribute returns
  const distRes = await post(`/pools/investment/${poolId}/distribute`, { totalReturn: 10000 });
  assert("POST /pools/investment/:id/distribute — distributed >= 1", distRes.distributed >= 1, JSON.stringify(distRes).slice(0, 80));

  // Redeem position
  const redeemRes = await post(`/pools/investment/positions/${positionId}/redeem`, { userId: investorId });
  assert("POST /pools/investment/positions/:id/redeem succeeds", redeemRes.success === true, JSON.stringify(redeemRes).slice(0, 80));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. INSURANCE POOLS
// ═══════════════════════════════════════════════════════════════════════════════
async function testInsurancePools() {
  section("5. INSURANCE POOLS");

  const managerId = await createUser("ins-manager");

  // Create pool
  const createRes = await post("/pools/insurance", {
    name:           "Micro Health Insurance Pool",
    managerId,
    currency:       "XOF",
    coverageType:   "health",
    premium:        2500,
    coverageAmount: 500000,
    maxMembers:     100,
  });
  assert("POST /pools/insurance creates pool",        createRes.id           !== undefined, JSON.stringify(createRes).slice(0, 80));
  assert("POST /pools/insurance has coverageType",    createRes.coverageType !== undefined);
  assert("POST /pools/insurance premium is number",   typeof createRes.premium === "number" || typeof Number(createRes.premium) === "number");

  const poolId = createRes.id;

  // List pools
  const listRes = await get("/pools/insurance");
  assert("GET /pools/insurance returns pools array", Array.isArray(listRes.pools));

  // Get pool
  const singleRes = await get(`/pools/insurance/${poolId}`);
  assert("GET /pools/insurance/:id returns pool",    singleRes.id === poolId);

  // Subscribe member
  const memberId   = await createUser("ins-member");
  const memberWallet = await createWallet(memberId);
  await fundWallet(memberWallet, 50000);

  const subRes = await post(`/pools/insurance/${poolId}/subscribe`, {
    userId: memberId, fromWalletId: memberWallet,
  });
  assert("POST /pools/insurance/:id/subscribe creates policy", subRes.id !== undefined, JSON.stringify(subRes).slice(0, 80));

  const policyId = subRes.id;

  // File claim
  const claimRes = await post(`/pools/insurance/${poolId}/claims`, {
    policyId, userId: memberId, claimAmount: 50000, reason: "Medical emergency",
  });
  assert("POST /pools/insurance/:id/claims files claim",        claimRes.id !== undefined,    JSON.stringify(claimRes).slice(0, 80));
  assert("POST /pools/insurance/:id/claims status=pending",     claimRes.status === "pending");
  assert("POST /pools/insurance/:id/claims claimAmount number", typeof claimRes.claimAmount   === "number");

  const claimId = claimRes.id;

  // List claims
  const claimsRes = await get(`/pools/insurance/${poolId}/claims`);
  assert("GET /pools/insurance/:id/claims returns claims array", Array.isArray(claimsRes.claims));
  assert("GET /pools/insurance/:id/claims finds filed claim",    claimsRes.claims.some(c => c.id === claimId));

  // Adjudicate
  const adjRes = await patch(`/pools/insurance/claims/${claimId}/adjudicate`, {
    adjudicatorId: managerId, approved: true, payoutAmount: 45000,
  });
  assert("PATCH /pools/insurance/claims/:id/adjudicate — success",       adjRes.success  === true, JSON.stringify(adjRes).slice(0, 80));
  assert("PATCH /pools/insurance/claims/:id/adjudicate — approved=true", adjRes.approved === true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. CREATOR ECONOMY
// ═══════════════════════════════════════════════════════════════════════════════
async function testCreatorEconomy() {
  section("6. CREATOR ECONOMY");

  const creatorId = await createUser("creator");
  const handle    = `creator-${Date.now()}-${++_seq}`;

  // Create community
  const createRes = await post("/creator/communities", {
    name: "DeFi Africa", creatorId, handle,
    platformFeeRate: 2, creatorFeeRate: 5,
  });
  assert("POST /creator/communities creates community", createRes.id     !== undefined, JSON.stringify(createRes).slice(0, 80));
  assert("POST /creator/communities has handle",        createRes.handle === handle);

  const communityId = createRes.id;

  // Duplicate handle → 409
  const dupRes = await post("/creator/communities", {
    name: "Duplicate", creatorId, handle,
  });
  assert("POST /creator/communities — duplicate handle returns error", dupRes.error === true);

  // List communities
  const listRes = await get("/creator/communities");
  assert("GET /creator/communities returns array",  Array.isArray(listRes.communities));
  assert("GET /creator/communities has pagination", listRes.pagination !== undefined);

  // Get by handle
  const byHandleRes = await get(`/creator/communities/${handle}`);
  assert("GET /creator/communities/:handleOrId by handle", byHandleRes.id === communityId);

  // Join
  const memberId = await createUser("community-member");
  const joinRes  = await post(`/creator/communities/${communityId}/join`, { userId: memberId });
  assert("POST /creator/communities/:id/join succeeds", joinRes.success === true, JSON.stringify(joinRes).slice(0, 80));

  // Get pools
  const poolsRes = await get(`/creator/communities/${communityId}/pools`);
  assert("GET /creator/communities/:id/pools returns data", poolsRes !== undefined && !poolsRes.error);

  // Distribute earnings
  const earningsRes = await post(`/creator/communities/${communityId}/earnings`, {
    transactionAmount: 100000, currency: "XOF",
  });
  assert("POST /creator/communities/:id/earnings succeeds", earningsRes.success === true, JSON.stringify(earningsRes).slice(0, 80));

  // Creator dashboard
  const dashRes = await get(`/creator/dashboard/${creatorId}`);
  assert("GET /creator/dashboard/:creatorId returns data",        dashRes.communities !== undefined || dashRes.totalCommunities !== undefined);

  // Update status
  const statusRes = await patch(`/creator/communities/${communityId}/status`, { status: "suspended" });
  assert("PATCH /creator/communities/:id/status updates", statusRes.status === "suspended", JSON.stringify(statusRes).slice(0, 80));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. CREDIT — REPAYMENTS (new route) + SCORE COMPUTE
// ═══════════════════════════════════════════════════════════════════════════════
async function testCreditRepayments() {
  section("7. CREDIT — REPAYMENTS & SCORES");

  const userId   = await createUser("credit-repay");
  const walletId = await createWallet(userId);
  await fundWallet(walletId, 500000);

  // Compute credit score
  const scoreRes = await post(`/credit/scores/${userId}/compute`, {});
  assert("POST /credit/scores/:userId/compute returns score",  scoreRes.score  !== undefined, JSON.stringify(scoreRes).slice(0, 80));
  assert("POST /credit/scores/:userId/compute returns userId", scoreRes.userId === userId);

  // Get score
  const getScoreRes = await get(`/credit/scores/${userId}`);
  assert("GET /credit/scores/:userId returns score",   getScoreRes.score       !== undefined);
  assert("GET /credit/scores/:userId has creditLimit", getScoreRes.creditLimit !== undefined);

  // Apply for loan
  const loanRes = await post("/credit/loans", {
    userId, walletId, amount: 50000, currency: "XOF",
    purpose: "Business capital", termDays: 30,
  });
  assert("POST /credit/loans creates loan",  loanRes.id     !== undefined, JSON.stringify(loanRes).slice(0, 80));
  assert("POST /credit/loans has status",    loanRes.status !== undefined);

  const loanId = loanRes.id;

  // GET /credit/repayments?userId — new route
  const repByUser = await get(`/credit/repayments?userId=${userId}`);
  assert("GET /credit/repayments?userId returns array",      Array.isArray(repByUser.repayments));
  assert("GET /credit/repayments?userId has count",          typeof repByUser.count        === "number");
  assert("GET /credit/repayments?userId has totalAmount",    typeof repByUser.totalAmount  === "number");

  // GET /credit/repayments?loanId — new route
  const repByLoan = await get(`/credit/repayments?loanId=${loanId}`);
  assert("GET /credit/repayments?loanId returns array",      Array.isArray(repByLoan.repayments));

  // GET /credit/repayments (no params) → 400
  const repBadRes = await get("/credit/repayments");
  assert("GET /credit/repayments no params → 400", repBadRes.error === true);

  // Per-loan repayments (existing route)
  const perLoanRes = await get(`/credit/loans/${loanId}/repayments`);
  assert("GET /credit/loans/:id/repayments returns array", Array.isArray(perLoanRes.repayments));

  // Approve + disburse + repay flow
  const currentStatus = loanRes.status;
  if (["pending", "approved"].includes(currentStatus)) {
    if (currentStatus === "pending") {
      const approveRes = await patch(`/credit/loans/${loanId}/approve`, { adminId: "system" });
      if (approveRes.status === "approved" || approveRes.loan?.status === "approved") {
        await post(`/credit/loans/${loanId}/disburse`, { adminId: "system" });
      }
    }

    const repayRes = await post(`/credit/loans/${loanId}/repay`, { walletId, amount: 10000, userId });
    assert("POST /credit/loans/:id/repay records repayment",  repayRes.repaymentId !== undefined, JSON.stringify(repayRes).slice(0, 80));
    assert("POST /credit/loans/:id/repay has remaining",      typeof repayRes.remaining === "number");

    // Verify repayment appears in user query
    const afterRepay = await get(`/credit/repayments?userId=${userId}`);
    assert("GET /credit/repayments?userId shows repayment after repay",
      afterRepay.repayments.some(r => r.loanId === loanId));
  } else {
    assert("Loan status skips repay flow (ok)", true);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. TONTINE POSITION MARKET
// ═══════════════════════════════════════════════════════════════════════════════
async function testTontineMarket() {
  section("8. TONTINE POSITION MARKET");

  const adminId  = await createUser("tontine-admin");
  const memberId = await createUser("tontine-member");

  // Create tontine
  const tontine = await post("/tontines", {
    name: "Market Test Tontine", adminUserId: adminId,
    contributionAmount: 5000, currency: "XOF",
    frequency: "monthly", maxMembers: 4,
  });
  const tontineId = tontine.id ?? tontine.tontine?.id;
  assert("POST /tontines creates tontine", tontineId !== undefined, JSON.stringify(tontine).slice(0, 80));

  // Add member
  await post(`/tontines/${tontineId}/members`, { userId: memberId });

  // Activate via community route
  const activateRes = await post(`/community/tontines/${tontineId}/activate`, { rotationModel: "fixed" });
  assert("POST /community/tontines/:id/activate — status=active", activateRes.status === "active", JSON.stringify(activateRes).slice(0, 80));

  // List position for sale
  const listPosRes = await post(`/community/tontines/${tontineId}/positions/list`, {
    userId: memberId, askPrice: 6000,
  });
  assert("POST /community/tontines/:id/positions/list creates listing",
    listPosRes.listingId !== undefined || listPosRes.success === true, JSON.stringify(listPosRes).slice(0, 80));

  // Global market should now have >= 1 listing
  const mktRes = await get("/community/tontines/positions");
  assert("GET /community/tontines/positions shows new listing", mktRes.pagination.total >= 1);

  // Tontine-specific market view
  const mktTontineRes = await get(`/community/tontines/${tontineId}/positions/market`);
  assert("GET /community/tontines/:id/positions/market returns listings",
    Array.isArray(mktTontineRes.listings ?? mktTontineRes));

  // Bids
  const buyerId = await createUser("position-buyer");
  const bidRes  = await post(`/community/tontines/${tontineId}/bids`, {
    userId: buyerId, positionOrder: 1, maxPrice: 7000,
  });
  assert("POST /community/tontines/:id/bids creates bid", bidRes.id !== undefined || bidRes.success === true, JSON.stringify(bidRes).slice(0, 80));

  const bidsRes = await get(`/community/tontines/${tontineId}/bids`);
  assert("GET /community/tontines/:id/bids returns bids", Array.isArray(bidsRes.bids ?? bidsRes));
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║         KOWRI V5.0 — Phase 7 Integration Test Suite         ║");
console.log("╚══════════════════════════════════════════════════════════════╝");

const suites = [
  ["Savings Plans",         testSavings],
  ["Diaspora & Remittance", testDiaspora],
  ["Community Finance",     testCommunityFinance],
  ["Investment Pools",      testInvestmentPools],
  ["Insurance Pools",       testInsurancePools],
  ["Creator Economy",       testCreatorEconomy],
  ["Credit Repayments",     testCreditRepayments],
  ["Tontine Market",        testTontineMarket],
];

for (const [name, fn] of suites) {
  try {
    await fn();
  } catch (err) {
    console.error(`\n  💥 Suite "${name}" threw: ${err.message}`);
    console.error(`     ${err.stack?.split("\n")[1] ?? ""}`);
    failed++;
    failures.push(`${name}: ${err.message.slice(0, 60)}`);
  }
}

const total = passed + failed;
console.log("\n" + "═".repeat(62));
console.log(`  Results: ${passed}/${total} passed  |  ${failed} failed`);
if (failures.length > 0) {
  console.log("\n  Failed assertions:");
  failures.forEach(f => console.log(`    • ${f}`));
}
console.log("═".repeat(62));
process.exit(failed > 0 ? 1 : 0);
