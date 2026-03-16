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

async function stressTest(concurrency, fromWalletId, toWalletId, amount = 10) {
  console.log(`\n  → Firing ${concurrency} concurrent transfers (${amount} each)...`);
  const start = Date.now();

  const [balBefore] = [(await get("/api/wallets/" + fromWalletId)).b?.balance ?? 0];

  const reqs = Array.from({ length: concurrency }, () =>
    post("/api/wallets/" + fromWalletId + "/transfer",
      { toWalletId, amount, currency: "XOF" },
      { "Idempotency-Key": randomUUID() }
    )
  );

  const results = await Promise.all(reqs);
  const elapsed = Date.now() - start;

  const success = results.filter((r) => r.s === 200).length;
  const failed = results.filter((r) => r.s >= 400 && r.s < 500).length;
  const errors = results.filter((r) => r.s >= 500 || r.s === 0).length;

  await new Promise((r) => setTimeout(r, 300));

  const balAfter = (await get("/api/wallets/" + fromWalletId)).b?.balance ?? 0;
  const expectedBalance = Number(balBefore) - success * amount;
  const balanceCorrect = Math.abs(Number(balAfter) - expectedBalance) < 0.01;

  const ledger = (await get("/api/analytics/ledger?limit=1")).b;
  const ledgerBalanced = Math.abs(ledger.totalDebits - ledger.totalCredits) < 0.01;

  console.log(`     Done in ${elapsed}ms | success=${success} failed=${failed} 5xx=${errors}`);
  console.log(`     Balance: before=${balBefore} expected=${expectedBalance} after=${balAfter} ✓=${balanceCorrect}`);
  console.log(`     Ledger drift: ${(ledger.totalDebits - ledger.totalCredits).toFixed(4)} ✓=${ledgerBalanced}`);

  return { concurrency, success, failed, errors, elapsed, balanceCorrect, ledgerBalanced };
}

async function fraudScenario(walletId, toWalletId) {
  console.log(`\n  → Fraud burst: 6 rapid transfers to trigger alert...`);
  const reqs = Array.from({ length: 6 }, (_, i) =>
    post("/api/wallets/" + walletId + "/transfer",
      { toWalletId, amount: 5, currency: "XOF" },
      { "Idempotency-Key": randomUUID() }
    )
  );
  await Promise.all(reqs);
  await new Promise((r) => setTimeout(r, 500));
  const alerts = (await get("/api/risk/alerts/" + walletId)).b?.alerts ?? [];
  const triggered = alerts.some((a) => a.alertType === "rapid_transfers");
  console.log(`     Rapid transfer alert triggered: ${triggered} (${alerts.length} total alerts for wallet)`);
  return triggered;
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║           KOWRI V5.0 — PHASE 3 STRESS TEST SUITE           ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  const wallets = (await get("/api/wallets?limit=20")).b?.wallets ?? [];
  const richWallet = wallets.find((w) => Number(w.balance) > 50000);
  const otherWallet = wallets.find((w) => w.id !== richWallet?.id && Number(w.balance) >= 0);

  if (!richWallet || !otherWallet) {
    console.log("ERROR: not enough wallets with balance");
    process.exit(1);
  }

  console.log(`\n  Source wallet: ${richWallet.id} | Balance: ${richWallet.balance}`);
  console.log(`  Target wallet: ${otherWallet.id}`);

  const results = [];

  console.log("\n── SCENARIO 1: 100 CONCURRENT TRANSFERS ──");
  results.push(await stressTest(100, richWallet.id, otherWallet.id, 10));

  await new Promise((r) => setTimeout(r, 1000));

  console.log("\n── SCENARIO 2: 1000 CONCURRENT TRANSFERS ──");
  results.push(await stressTest(1000, richWallet.id, otherWallet.id, 5));

  console.log("\n── SCENARIO 3: FRAUD DETECTION BURST ──");
  const fraudWallet = wallets.find((w) => w.id !== richWallet.id && w.id !== otherWallet.id && Number(w.balance) > 100);
  const fraudTriggered = await fraudScenario(fraudWallet?.id ?? richWallet.id, otherWallet.id);

  console.log("\n── SCENARIO 4: IDEMPOTENCY STRESS (50x same key) ──");
  const sameKey = randomUUID();
  const idempReqs = Array.from({ length: 50 }, () =>
    post("/api/wallets/" + richWallet.id + "/deposit",
      { amount: 100, currency: "XOF", reference: "IDEMP-STRESS-" + Date.now() },
      { "Idempotency-Key": sameKey }
    )
  );
  const idempResults = await Promise.all(idempReqs);
  const replayed = idempResults.filter((r) => r.h["x-idempotent-replayed"] === "true").length;
  const newTx = idempResults.filter((r) => r.s === 200 && r.h["x-idempotent-replayed"] !== "true").length;
  console.log(`\n  50 concurrent same-key deposits → new=${newTx} replayed=${replayed}`);

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("STRESS TEST SUMMARY");
  console.log("══════════════════════════════════════════════════════════════");
  for (const r of results) {
    const ok = r.errors === 0 && r.balanceCorrect && r.ledgerBalanced;
    console.log(`  ${ok ? "✅" : "❌"} ${r.concurrency} concurrent | success=${r.success} | ${r.elapsed}ms | balance=${r.balanceCorrect ? "✓" : "✗"} | ledger=${r.ledgerBalanced ? "✓" : "✗"}`);
  }
  console.log(`  ${fraudTriggered ? "✅" : "❌"} Fraud detection alert triggered`);
  console.log(`  ${newTx === 1 && replayed === 49 ? "✅" : "⚠️ "} Idempotency: 1 new + ${replayed} replayed (expected 1+49)`);

  const allOk = results.every((r) => r.errors === 0 && r.balanceCorrect && r.ledgerBalanced) && fraudTriggered;
  console.log("\n" + (allOk ? "🎯 ALL STRESS TESTS PASSED" : "⚠️  Some stress tests need attention"));
  console.log("══════════════════════════════════════════════════════════════");
}

main().catch((err) => { console.error(err); process.exit(1); });
