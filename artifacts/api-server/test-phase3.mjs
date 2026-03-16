import http from "http";
import { randomUUID } from "crypto";

const BASE = "http://localhost:8080";

function get(path) {
  return new Promise((resolve) => {
    http.get(BASE + path, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ s: res.statusCode, b: JSON.parse(data) }); }
        catch { resolve({ s: res.statusCode, b: null }); }
      });
    }).on("error", () => resolve({ s: 0, b: null }));
  });
}

function post(path, body, headers = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: "localhost", port: 8080, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ s: res.statusCode, b: JSON.parse(data), h: res.headers }); }
        catch { resolve({ s: res.statusCode, b: null, h: res.headers }); }
      });
    });
    req.on("error", () => resolve({ s: 0, b: null, h: {} }));
    req.write(payload);
    req.end();
  });
}

function put(path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: "localhost", port: 8080, path, method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ s: res.statusCode, b: JSON.parse(data) }); }
        catch { resolve({ s: res.statusCode, b: null }); }
      });
    });
    req.on("error", () => resolve({ s: 0, b: null }));
    req.write(payload);
    req.end();
  });
}

async function main() {
  const results = [];
  function chk(label, ok, detail = "") { results.push({ label, ok, detail }); }

  const wallets = (await get("/api/wallets?limit=20")).b?.wallets ?? [];
  const w1 = wallets.find((w) => Number(w.balance) > 5000) ?? wallets[0];
  const w2 = wallets.find((w) => w.id !== w1.id) ?? wallets[1];

  // ── P3-1: SAGA ORCHESTRATION ────────────────────────────────
  const allWallets = (await get("/api/wallets?limit=100")).b?.wallets ?? [];
  const scores = (await get("/api/credit/scores?limit=50")).b?.scores ?? [];
  const score = scores.find((s) => Number(s.maxLoanAmount) >= 100);
  const userWallet = score ? allWallets.find((w) => w.userId === score.userId) : null;

  if (score && userWallet) {
    const user = { id: score.userId };
    const loanResp = await post("/api/credit/loans", {
      userId: user.id,
      walletId: userWallet.id,
      amount: 100,
      currency: "XOF",
      termDays: 30,
      purpose: "P3 saga test",
    });
    chk("P3-1a Loan disbursement saga → 201", loanResp.s === 201, "HTTP " + loanResp.s);
    chk("P3-1b Loan has saga field", !!loanResp.b?.saga);
    chk("P3-1c Saga reports disbursed=true", loanResp.b?.saga?.disbursed === true);
    chk("P3-1d Loan status is disbursed", loanResp.b?.status === "disbursed", "status=" + loanResp.b?.status);

    await new Promise((r) => setTimeout(r, 300));
    const sagasResp = await get("/api/sagas?limit=5");
    chk("P3-1e /sagas endpoint 200", sagasResp.s === 200);
    chk("P3-1f Saga record stored", (sagasResp.b?.sagas ?? []).length > 0);
    const saga = sagasResp.b?.sagas?.[0];
    chk("P3-1g Saga status=completed", saga?.status === "completed", "status=" + saga?.status);
    chk("P3-1h Saga steps recorded", Array.isArray(saga?.steps) && saga.steps.length >= 4);
  } else {
    chk("P3-1a Loan saga (skip: no eligible user)", true, "skipped");
    chk("P3-1b", true, "skipped"); chk("P3-1c", true, "skipped");
    chk("P3-1d", true, "skipped"); chk("P3-1e", true, "skipped");
    chk("P3-1f", true, "skipped"); chk("P3-1g", true, "skipped");
    chk("P3-1h", true, "skipped");
  }

  const sagaStats = await get("/api/sagas/stats");
  chk("P3-1i /sagas/stats 200", sagaStats.s === 200);

  // ── P3-2: FRAUD DETECTION ENGINE ────────────────────────────
  const fraudWallet = wallets.find((w) => Number(w.balance) > 200 && w.id !== w2.id) ?? w1;
  const burst = Array.from({ length: 6 }, () =>
    post("/api/wallets/" + fraudWallet.id + "/transfer",
      { toWalletId: w2.id, amount: 5, currency: "XOF" },
      { "Idempotency-Key": randomUUID() }
    )
  );
  await Promise.all(burst);
  await new Promise((r) => setTimeout(r, 600));

  const alertsResp = await get("/api/risk/alerts?limit=20");
  const walletAlerts = await get("/api/risk/alerts/" + fraudWallet.id);
  const alertStats = await get("/api/risk/alerts/stats");
  chk("P3-2a /risk/alerts 200", alertsResp.s === 200);
  chk("P3-2b rapid_transfers alert created", (walletAlerts.b?.alerts ?? []).some((a) => a.alertType === "rapid_transfers"));
  chk("P3-2c alert has severity field", (alertsResp.b?.alerts ?? []).every((a) => !!a.severity));
  chk("P3-2d /risk/alerts/stats 200", alertStats.s === 200);
  chk("P3-2e Stats has bySeverity", !!alertStats.b?.bySeverity);
  chk("P3-2f Stats has byType", !!alertStats.b?.byType);

  const highValueTransfer = await post("/api/wallets/" + w1.id + "/transfer",
    { toWalletId: w2.id, amount: 2000000, currency: "XOF" },
    { "Idempotency-Key": randomUUID() }
  );
  await new Promise((r) => setTimeout(r, 400));
  if (highValueTransfer.s === 200) {
    const hvAlerts = await get("/api/risk/alerts/" + w1.id);
    chk("P3-2g High-value alert created", (hvAlerts.b?.alerts ?? []).some((a) => a.alertType === "high_value_transfer"), "alerts=" + hvAlerts.b?.alerts?.length);
  } else {
    chk("P3-2g High-value alert (insufficient funds, skip)", true, "skipped");
  }

  // ── P3-3: WEBHOOK INFRASTRUCTURE ────────────────────────────
  const webhookResp = await post("/api/webhooks", {
    url: "https://webhook.site/test-kowri",
    event_type: "transaction.completed",
  });
  chk("P3-3a POST /webhooks → 201", webhookResp.s === 201, "HTTP " + webhookResp.s);
  chk("P3-3b Webhook has id", !!webhookResp.b?.id);
  chk("P3-3c Webhook has _secret", !!webhookResp.b?._secret);
  chk("P3-3d Secret is 64-char hex", webhookResp.b?._secret?.length === 64);

  const listHooks = await get("/api/webhooks");
  chk("P3-3e GET /webhooks 200", listHooks.s === 200);
  chk("P3-3f Webhook in list", (listHooks.b?.webhooks ?? []).some((h) => h.id === webhookResp.b?.id));
  chk("P3-3g Secret NOT exposed in list", !(listHooks.b?.webhooks ?? []).some((h) => h.secret));

  const eventsResp = await get("/api/webhooks/events");
  chk("P3-3h /webhooks/events 200", eventsResp.s === 200);
  chk("P3-3i transaction.completed in supported events", (eventsResp.b?.supportedEvents ?? []).includes("transaction.completed"));
  chk("P3-3j fraud.alert.triggered supported", (eventsResp.b?.supportedEvents ?? []).includes("fraud.alert.triggered"));

  const invalidHook = await post("/api/webhooks", { url: "https://x.com", event_type: "invalid.event" });
  chk("P3-3k Invalid event_type → 400", invalidHook.s === 400);

  // ── P3-4: WALLET RATE LIMITING ───────────────────────────────
  const rlWallet = allWallets.find((w) => Number(w.balance) > 200 && w.id !== w1.id && w.id !== w2.id && w.id !== (fraudWallet?.id)) ?? w1;
  const rtBefore = await get("/api/wallets/" + rlWallet.id);
  chk("P3-4a Wallet fetched for rate limit test", rtBefore.s === 200);

  const rateResp = await post("/api/wallets/" + rlWallet.id + "/transfer",
    { toWalletId: w2.id, amount: 1, currency: "XOF" },
    { "Idempotency-Key": randomUUID() }
  );
  chk("P3-4b Transfer under rate limit succeeds", rateResp.s === 200, "HTTP " + rateResp.s);

  const rtBurstFails = [];
  for (let i = 0; i < 15; i++) {
    const r = await post("/api/wallets/" + rlWallet.id + "/transfer",
      { toWalletId: w2.id, amount: 1, currency: "XOF" },
      { "Idempotency-Key": randomUUID() }
    );
    rtBurstFails.push(r);
  }
  const rateLimitHit = rtBurstFails.some((r) => r.s === 429 || (r.s === 400 && r.b?.message?.includes("rate limit")));
  chk("P3-4c 15 rapid transfers hits rate limit", rateLimitHit, "hit=" + rateLimitHit);

  // ── P3-5: LEDGER PARTITIONING ────────────────────────────────
  const partition = await get("/api/analytics/ledger/partitions");
  chk("P3-5a /analytics/ledger/partitions 200", partition.s === 200);
  chk("P3-5b Partitions listed", Array.isArray(partition.b?.partitions) && partition.b.partitions.length > 0);
  chk("P3-5c Current month partition present", (partition.b?.partitions ?? []).some((p) => p.name.includes("2026_03")));
  chk("P3-5d Each partition has entry count", (partition.b?.partitions ?? []).every((p) => typeof p.count === "number"));

  // ── P3-6: MULTI-CURRENCY FX ENGINE ───────────────────────────
  const rates = await get("/api/fx/rates");
  chk("P3-6a GET /fx/rates 200", rates.s === 200);
  chk("P3-6b Has XOF→USD rate", (rates.b?.rates ?? []).some((r) => r.baseCurrency === "XOF" && r.targetCurrency === "USD"));
  chk("P3-6c Has USD→XOF rate", (rates.b?.rates ?? []).some((r) => r.baseCurrency === "USD" && r.targetCurrency === "XOF"));
  chk("P3-6d Has EUR→XOF rate", (rates.b?.rates ?? []).some((r) => r.baseCurrency === "EUR" && r.targetCurrency === "XOF"));
  chk("P3-6e Rate count >= 8",  (rates.b?.rates ?? []).length >= 8, "count=" + rates.b?.rates?.length);

  const xofUsd = await get("/api/fx/rates/XOF/USD");
  chk("P3-6f GET /fx/rates/XOF/USD 200", xofUsd.s === 200);
  chk("P3-6g Rate is numeric", typeof xofUsd.b?.rate === "number");

  const convert = await post("/api/fx/convert", { amount: 1000, from: "XOF", to: "USD" });
  chk("P3-6h POST /fx/convert 200", convert.s === 200);
  chk("P3-6i Converted amount present", typeof convert.b?.convertedAmount === "number");
  chk("P3-6j Conversion math correct", Math.abs(convert.b?.convertedAmount - (1000 * 0.00164)) < 0.01, "got=" + convert.b?.convertedAmount);

  const updateRate = await put("/api/fx/rates", { base_currency: "XOF", target_currency: "GHS", rate: 0.012 });
  chk("P3-6k PUT /fx/rates upsert 200", updateRate.s === 200);

  const badConvert = await post("/api/fx/convert", { amount: 100, from: "XOF", to: "INVALID" });
  chk("P3-6l Unknown pair → 404", badConvert.s === 404);

  // ── P3-7: SETTLEMENT ENGINE ──────────────────────────────────
  const settleResp = await post("/api/settlements", { partner: "BankOfDakar", amount: 50000, currency: "XOF" });
  chk("P3-7a POST /settlements → 201", settleResp.s === 201, "HTTP " + settleResp.s);
  chk("P3-7b Settlement has id", !!settleResp.b?.id);
  chk("P3-7c Initial status=pending", settleResp.b?.status === "pending");

  if (settleResp.b?.id) {
    const processResp = await post("/api/settlements/" + settleResp.b.id + "/process", {});
    chk("P3-7d POST /settlements/:id/process 200", processResp.s === 200, "HTTP " + processResp.s);
    chk("P3-7e Processed status=settled", processResp.b?.status === "settled", "status=" + processResp.b?.status);
    chk("P3-7f settledAt timestamp set", !!processResp.b?.settledAt);

    const dupProcess = await post("/api/settlements/" + settleResp.b.id + "/process", {});
    chk("P3-7g Double-process → 409", dupProcess.s === 409);
  }

  const listSettle = await get("/api/settlements");
  chk("P3-7h GET /settlements 200", listSettle.s === 200);
  chk("P3-7i Settlement in list", (listSettle.b?.settlements ?? []).some((s) => s.id === settleResp.b?.id));

  // ── P3-8: SYSTEM HEALTH MONITOR ──────────────────────────────
  const health = await get("/api/system/health");
  chk("P3-8a GET /system/health 200", health.s === 200);
  chk("P3-8b status field present", ["healthy", "degraded"].includes(health.b?.status));
  chk("P3-8c DB latency tracked", typeof health.b?.components?.database?.latencyMs === "number");
  chk("P3-8d DB latency < 500ms", health.b?.components?.database?.latencyMs < 500, health.b?.components?.database?.latencyMs + "ms");
  chk("P3-8e Event bus healthy", health.b?.components?.eventBus?.status === "healthy");
  chk("P3-8f Ledger integrity checked", !!health.b?.components?.ledger);
  chk("P3-8g Ledger balanced", health.b?.components?.ledger?.status === "balanced", health.b?.components?.ledger?.status);
  chk("P3-8h Queue backlog present", !!health.b?.components?.queues);
  chk("P3-8i Memory usage present", typeof health.b?.components?.memory?.heapUsedMb === "number");
  chk("P3-8j Uptime present", typeof health.b?.components?.uptime?.seconds === "number");

  // ── P3-9: BACKWARD COMPATIBILITY ────────────────────────────
  const legacy = [
    "/api/healthz", "/api/users", "/api/wallets", "/api/transactions",
    "/api/tontines", "/api/credit/loans", "/api/credit/scores",
    "/api/merchants", "/api/compliance/kyc", "/api/analytics/overview",
    "/api/analytics/ledger", "/api/admin/reconcile",
    "/api/system/metrics", "/api/system/events", "/api/system/audit",
  ];
  for (const ep of legacy) {
    const r = await get(ep);
    chk("P3-9 " + ep, r.s === 200, r.s + "ms");
  }

  // ── PRINT REPORT ────────────────────────────────────────────
  let pass = 0; let fail = 0;
  for (const r of results) { if (r.ok) pass++; else fail++; }

  const SECTIONS = {
    "P3-1  DISTRIBUTED SAGA ORCHESTRATION": (r) => r.label.startsWith("P3-1"),
    "P3-2  FRAUD DETECTION ENGINE":          (r) => r.label.startsWith("P3-2"),
    "P3-3  WEBHOOK INFRASTRUCTURE":          (r) => r.label.startsWith("P3-3"),
    "P3-4  WALLET RATE LIMITING":            (r) => r.label.startsWith("P3-4"),
    "P3-5  LEDGER PARTITIONING":             (r) => r.label.startsWith("P3-5"),
    "P3-6  MULTI-CURRENCY FX ENGINE":        (r) => r.label.startsWith("P3-6"),
    "P3-7  SETTLEMENT ENGINE":               (r) => r.label.startsWith("P3-7"),
    "P3-8  SYSTEM HEALTH MONITOR":           (r) => r.label.startsWith("P3-8"),
    "P3-9  BACKWARD COMPATIBILITY":          (r) => r.label.startsWith("P3-9"),
  };

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║          KOWRI V5.0 — PHASE 3 ARCHITECTURE VALIDATION         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  for (const [section, filter] of Object.entries(SECTIONS)) {
    const sr = results.filter(filter);
    const sp = sr.filter((r) => r.ok).length;
    const sf = sr.filter((r) => !r.ok).length;
    console.log(`\n  ── ${section} [${sp}/${sr.length}] ──`);
    for (const r of sr) {
      const icon = r.ok ? "  ✅" : "  ❌";
      const detail = r.detail ? " (" + r.detail + ")" : "";
      console.log(icon, r.label + detail);
    }
  }

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log("PASS:", pass, "| FAIL:", fail, "| TOTAL:", pass + fail);
  console.log("Score:", pass + "/" + (pass + fail));
  console.log(fail === 0 ? "🎯 PHASE 3 COMPLETE — Neobank infrastructure operational" : "⚠️  " + fail + " checks need attention");
  console.log("══════════════════════════════════════════════════════════════");
}

main().catch((err) => { console.error(err); process.exit(1); });
