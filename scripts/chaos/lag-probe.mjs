#!/usr/bin/env node
// Scenario: replica lag detection blind spot
// Simulates lag pressure by running a long-running pg_sleep query on the DB
// while polling /api/system/replica/status every 500 ms for 30 s.
// Prints a timeline of health state transitions.
//
// Run: node scripts/chaos/lag-probe.mjs
// Requires: DATABASE_URL env var

import { execSync } from "node:child_process";

const BASE         = "http://localhost:8080";
const PROBE_MS     = 500;
const DURATION_MS  = 30_000;
const DB           = process.env.DATABASE_URL;

if (!DB) { console.error("DATABASE_URL not set"); process.exit(1); }

// Fire a 15 s pg_sleep in the background to simulate I/O pressure / WAL stall
console.log("Starting 15 s pg_sleep query to simulate replica pressure...");
const sleepProc = new Promise((resolve) => {
  try {
    execSync(`psql "${DB}" -c "SELECT pg_sleep(15);" 2>/dev/null`, { timeout: 20_000 });
  } catch {}
  resolve();
});

// ── Poll replica status ───────────────────────────────────────────────────────
const start    = Date.now();
const timeline = [];
let   lastState = null;

console.log(`Probing replica status every ${PROBE_MS} ms for ${DURATION_MS / 1000} s...\n`);
console.log("  t(ms)   healthy   lagSec   lagNull   windowMs");
console.log("  ────────────────────────────────────────────");

const interval = setInterval(async () => {
  const t = Date.now() - start;
  if (t > DURATION_MS) {
    clearInterval(interval);
    printSummary(timeline);
    return;
  }

  try {
    const [replica, advisor] = await Promise.all([
      fetch(`${BASE}/api/system/replica/status`).then(r => r.json()),
      fetch(`${BASE}/api/system/sticky/advisor`).then(r => r.json()),
    ]);

    const state = `${replica.healthy}|${replica.lagSec}|${replica.lagNull}`;
    const entry = {
      t,
      healthy:   replica.healthy,
      lagSec:    replica.lagSec,
      lagNull:   replica.lagNull,
      windowMs:  advisor.currentWindowMs,
    };

    timeline.push(entry);

    if (state !== lastState) {
      console.log(
        `  ${String(t).padStart(6)}  ${String(entry.healthy).padEnd(7)}  ` +
        `${String(entry.lagSec).padEnd(7)}  ${String(entry.lagNull).padEnd(8)}  ${entry.windowMs}`
      );
      lastState = state;
    }
  } catch (e) {
    console.error(`  ${Date.now() - start} ms — probe failed:`, e.message);
  }
}, PROBE_MS);

function printSummary(tl) {
  const unhealthyWindows = tl.filter(e => !e.healthy);
  const nullWindows      = tl.filter(e => e.lagNull);
  const maxLag           = Math.max(...tl.map(e => e.lagSec));
  const maxWindow        = Math.max(...tl.map(e => e.windowMs));

  console.log("\n── Summary ──────────────────────────────────────");
  console.log(`  total samples  : ${tl.length}`);
  console.log(`  unhealthy ticks: ${unhealthyWindows.length}  (${(unhealthyWindows.length * PROBE_MS / 1000).toFixed(1)} s unhealthy)`);
  console.log(`  null-lag ticks : ${nullWindows.length}`);
  console.log(`  peak lagSec    : ${maxLag}`);
  console.log(`  peak windowMs  : ${maxWindow}`);

  const stateChanges = tl.filter((e, i) =>
    i === 0 || e.healthy !== tl[i-1].healthy || e.lagNull !== tl[i-1].lagNull
  );
  console.log(`  state changes  : ${stateChanges.length}`);
  if (stateChanges.length <= 1) {
    console.log("\n⚠️  BLIND SPOT: replica status never changed during lag injection");
    console.log("   Reads routed to stale replica for the full probe window.");
  } else {
    console.log("\n✅ Health transitions detected — failover logic fired");
  }
}

await sleepProc;
