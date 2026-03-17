#!/usr/bin/env node
// Scenario: concurrent transactions
// Fires N simultaneous wallet transfers to trigger deadlocks and serialization
// failures. Reports final balance drift (should be zero).
//
// Run: node scripts/chaos/concurrent-transfers.mjs
// Tune: CONCURRENCY, TRANSFER_AMOUNT

const BASE   = "http://localhost:8080";
const CONCURRENCY    = 50;
const TRANSFER_AMOUNT = 100;
const SEED_AMOUNT    = CONCURRENCY * TRANSFER_AMOUNT * 2;

const post = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(r => r.json());

const get = (path) => fetch(`${BASE}${path}`).then(r => r.json());

// ── Setup ─────────────────────────────────────────────────────────────────────
const [u1, u2] = await Promise.all([
  post("/api/users", { name: "chaos-sender",   email: `cs-${Date.now()}@chaos.io`,   phone: "+22500000001" }),
  post("/api/users", { name: "chaos-receiver", email: `cr-${Date.now()}@chaos.io`, phone: "+22500000002" }),
]);

const [w1, w2] = await Promise.all([
  post("/api/wallets", { userId: u1.id, currency: "XOF", type: "personal" }),
  post("/api/wallets", { userId: u2.id, currency: "XOF", type: "personal" }),
]);

// Seed sender wallet
await post("/api/wallets/" + w1.id + "/deposit", { amount: SEED_AMOUNT, currency: "XOF" });

console.log(`Sender   wallet: ${w1.id}  balance: ${SEED_AMOUNT} XOF`);
console.log(`Receiver wallet: ${w2.id}  balance: 0 XOF`);
console.log(`Firing ${CONCURRENCY} concurrent transfers of ${TRANSFER_AMOUNT} XOF each...`);

const start = Date.now();

// ── Concurrent transfer burst ─────────────────────────────────────────────────
const results = await Promise.allSettled(
  Array.from({ length: CONCURRENCY }, () =>
    post("/api/transactions", {
      fromWalletId: w1.id,
      toWalletId:   w2.id,
      amount:       TRANSFER_AMOUNT,
      currency:     "XOF",
      type:         "transfer",
    })
  )
);

const elapsed = Date.now() - start;

const ok      = results.filter(r => r.status === "fulfilled" && !r.value.error).length;
const failed  = results.filter(r => r.status === "fulfilled" &&  r.value.error).length;
const thrown  = results.filter(r => r.status === "rejected").length;

// ── Balance consistency check ─────────────────────────────────────────────────
const [final1, final2] = await Promise.all([
  get(`/api/wallets/${w1.id}`),
  get(`/api/wallets/${w2.id}`),
]);

const expectedSender   = SEED_AMOUNT - ok * TRANSFER_AMOUNT;
const expectedReceiver = ok * TRANSFER_AMOUNT;
const drift1 = (final1.wallet?.balance ?? final1.balance ?? 0) - expectedSender;
const drift2 = (final2.wallet?.balance ?? final2.balance ?? 0) - expectedReceiver;

console.log(`\nResults (${elapsed} ms):`);
console.log(`  succeeded : ${ok}`);
console.log(`  app-error : ${failed}`);
console.log(`  thrown    : ${thrown}`);
console.log(`\nBalance consistency:`);
console.log(`  sender   expected=${expectedSender}  drift=${drift1}`);
console.log(`  receiver expected=${expectedReceiver}  drift=${drift2}`);
console.log(drift1 === 0 && drift2 === 0 ? "\n✅ CONSISTENT" : "\n❌ DRIFT DETECTED");
