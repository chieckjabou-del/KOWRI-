#!/usr/bin/env node
// Scenario: retry storm
// Inserts three event classes directly into outbox_events:
//   A) permanent  — malformed payload that will dead-letter on first attempt
//   B) transient  — valid structure, simulated transient failure via bad topic
//      that triggers retries (worker emits but downstream throws)
//   C) valid      — control group; should deliver cleanly
//
// Then polls /api/system/outbox/status every 3 s for 60 s and prints
// how pending / dead / fenceEntries evolve over time.
//
// Run: node scripts/chaos/retry-storm.mjs
// Requires: DATABASE_URL env var, server running on :8080

import { execSync } from "node:child_process";

const BASE  = "http://localhost:8080";
const DB    = process.env.DATABASE_URL;
const POLL  = 3_000;
const TOTAL = 60_000;

if (!DB) { console.error("DATABASE_URL not set"); process.exit(1); }

const uid = () => `chaos-${Math.random().toString(36).slice(2, 10)}`;

// ── Inject events via psql ────────────────────────────────────────────────────
console.log("Injecting chaos events into outbox_events...");

// Group A — permanent: violates FK (nonexistent entity reference, bad JSON type)
// Will be classified as "permanent" → DLQ on attempt 1
const groupA = Array.from({ length: 10 }, (_, i) => `(
  '${uid()}', 'payment.chaos_permanent_${i}',
  '{"violates": "foreign_key_constraint", "walletId": "nonexistent-${i}"}'::jsonb,
  'pending', 0, 1, now()
)`).join(",\n");

// Group B — transient: valid topic, good payload, but
// worker will fail on downstream emit → retries with deadlock policy
const groupB = Array.from({ length: 20 }, (_, i) => `(
  '${uid()}', 'payment.chaos_transient_${i}',
  '{"amount": ${(i + 1) * 100}, "currency": "XOF", "chaos": true}'::jsonb,
  'pending', 0, 1, now()
)`).join(",\n");

// Group C — valid control: analytics events, should queue and deliver normally
const groupC = Array.from({ length: 10 }, (_, i) => `(
  '${uid()}', 'analytics.chaos_control_${i}',
  '{"event": "control_${i}"}'::jsonb,
  'pending', 0, 9, now()
)`).join(",\n");

execSync(`psql "${DB}" -q <<'SQL'
INSERT INTO outbox_events (id, topic, payload, status, attempts, priority, process_at)
VALUES ${groupA};
INSERT INTO outbox_events (id, topic, payload, status, attempts, priority, process_at)
VALUES ${groupB};
INSERT INTO outbox_events (id, topic, payload, status, attempts, priority, process_at)
VALUES ${groupC};
SQL`);

console.log("  Group A (permanent ×10):  DLQ expected on attempt 1");
console.log("  Group B (transient ×20):  retry cascade expected");
console.log("  Group C (analytics ×10):  delayed delivery (priority 9)");

// ── Poll outbox status ────────────────────────────────────────────────────────
const start    = Date.now();
const snapshots = [];

console.log(`\nPolling /api/system/outbox/status every ${POLL / 1000} s for ${TOTAL / 1000} s...\n`);
console.log("  t(s)   pending  processing  delivered  dead  fenceEntries  deadByClass");
console.log("  ─────────────────────────────────────────────────────────────────────");

await new Promise((resolve) => {
  const interval = setInterval(async () => {
    const t = Math.round((Date.now() - start) / 1000);
    try {
      const { outbox } = await fetch(`${BASE}/api/system/outbox/status`).then(r => r.json());
      snapshots.push({ t, ...outbox });

      const cls = JSON.stringify(outbox.deadByClass ?? {});
      console.log(
        `  ${String(t).padStart(4)}   ` +
        `${String(outbox.pending).padStart(7)}  ` +
        `${String(outbox.processing).padStart(10)}  ` +
        `${String(outbox.delivered).padStart(9)}  ` +
        `${String(outbox.dead).padStart(4)}  ` +
        `${String(outbox.fenceEntries).padStart(12)}  ` +
        cls
      );
    } catch (e) {
      console.error(`  ${t}s — poll failed:`, e.message);
    }

    if (Date.now() - start >= TOTAL) {
      clearInterval(interval);
      resolve();
    }
  }, POLL);
});

// ── Summary ───────────────────────────────────────────────────────────────────
const last = snapshots[snapshots.length - 1] ?? {};
console.log("\n── Summary ──────────────────────────────────────────────────");
console.log(`  dead events    : ${last.dead ?? "?"}`);
console.log(`  fence entries  : ${last.fenceEntries ?? "?"}`);
console.log(`  dead by class  : ${JSON.stringify(last.deadByClass ?? {})}`);

const permDead = (last.deadByClass ?? {})["permanent"] ?? 0;
console.log(permDead >= 10
  ? "\n✅ Group A correctly dead-lettered (permanent class)"
  : "\n⚠️  Group A not yet dead-lettered — retries still in flight");

// ── Cleanup ───────────────────────────────────────────────────────────────────
console.log("\nCleaning up chaos events...");
execSync(`psql "${DB}" -q -c "DELETE FROM outbox_events WHERE topic LIKE '%chaos%';" 2>/dev/null || true`);
execSync(`psql "${DB}" -q -c "DELETE FROM processed_events WHERE topic LIKE '%chaos%';" 2>/dev/null || true`);
console.log("Done.");
