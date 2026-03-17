import { getReplicaLagState } from "./dbRouter";
import { getMetrics } from "./metrics";

// ── Bounds ────────────────────────────────────────────────────────────────────
export const MIN_STICKY_MS  = 3_000;
export const MAX_STICKY_MS  = 30_000;
const BASE_MS               = Number(process.env.STICKY_PRIMARY_MS ?? 7_000);

// ── Sliding error-rate tracker (60 s window) ──────────────────────────────────
// Each bucket = one 5 s slot → 12 buckets = 60 s
const BUCKET_MS    = 5_000;
const BUCKET_COUNT = 12;

interface Bucket { requests: number; errors: number; ts: number }

const buckets: Bucket[] = [];

function currentBucket(): Bucket {
  const now   = Date.now();
  const slotTs = now - (now % BUCKET_MS);
  let b = buckets[buckets.length - 1];
  if (!b || b.ts !== slotTs) {
    b = { requests: 0, errors: 0, ts: slotTs };
    buckets.push(b);
    if (buckets.length > BUCKET_COUNT) buckets.shift();
  }
  return b;
}

export function recordRequest(): void    { currentBucket().requests++; }
// Only increments errors — recordRequest() already counted this request on the way in.
export function recordErrorEvent(): void { currentBucket().errors++; }

function slidingErrorRate(): number {
  const cutoff = Date.now() - BUCKET_COUNT * BUCKET_MS;
  let req = 0, err = 0;
  for (const b of buckets) {
    if (b.ts < cutoff) continue;
    req += b.requests;
    err += b.errors;
  }
  return req === 0 ? 0 : err / req;
}

// ── Decision rules ────────────────────────────────────────────────────────────
//
//  Inputs
//    lagSec      replica lag in seconds (-1 = NULL / unknown)
//    healthy     replica health flag
//    p99Ms       p99 request latency in ms (from metrics ring buffer)
//    errorRate   fraction 0..1 from 60 s sliding window
//
//  Rules (evaluated top-down, first match wins)
//    1. Replica unhealthy or lag NULL   → MAX  (full protection while replica is down)
//    2. lag > threshold                 → MAX  (lag has blown past the threshold)
//    3. lag > 0.75 × threshold          → clamp(BASE × 3, _, MAX)   (approaching limit)
//    4. errorRate > 10 %                → clamp(BASE × 2, _, MAX)   (elevated errors)
//    5. errorRate > 5 %                 → clamp(BASE × 1.5, _, MAX) (moderate errors)
//    6. p99 > 1 000 ms                  → clamp(BASE × 1.5, _, MAX) (very slow primary)
//    7. p99 > 500 ms                    → clamp(BASE × 1.25, _, MAX)(slow primary)
//    8. default                         → BASE × max(1, lag/threshold), clamped [MIN, MAX]
//
//  Final clamp: always within [MIN_STICKY_MS, MAX_STICKY_MS]

// ── 1-second result cache ─────────────────────────────────────────────────────
// Inputs (lag, p99 latency, error rate) change on timescales of seconds to
// minutes.  Recomputing on every write request is wasteful: getMetrics() sorts
// up to 1 000 latency samples each call.  Cache the result for 1 s.
let _cachedWindow = BASE_MS;
let _cachedAt     = 0;

export function computeStickyWindowMs(): number {
  const now = Date.now();
  if (now - _cachedAt < 1_000) return _cachedWindow;

  const { lagSec, healthy, thresholdSec } = getReplicaLagState();
  const metrics   = getMetrics();
  const p99Ms     = metrics.transactions.latency.p99 ?? 0;
  const errorRate = slidingErrorRate();

  let windowMs: number;

  if (!healthy || lagSec < 0) {
    windowMs = MAX_STICKY_MS;
  } else if (lagSec > thresholdSec) {
    windowMs = MAX_STICKY_MS;
  } else if (lagSec > thresholdSec * 0.75) {
    windowMs = BASE_MS * 3;
  } else if (errorRate > 0.10) {
    windowMs = BASE_MS * 2;
  } else if (errorRate > 0.05) {
    windowMs = BASE_MS * 1.5;
  } else if (p99Ms > 1_000) {
    windowMs = BASE_MS * 1.5;
  } else if (p99Ms > 500) {
    windowMs = BASE_MS * 1.25;
  } else {
    const ratio = thresholdSec > 0 ? lagSec / thresholdSec : 0;
    windowMs = BASE_MS * Math.max(1, ratio);
  }

  _cachedWindow = Math.round(Math.min(MAX_STICKY_MS, Math.max(MIN_STICKY_MS, windowMs)));
  _cachedAt     = now;
  return _cachedWindow;
}

export function getAdvisorStats() {
  return {
    currentWindowMs: computeStickyWindowMs(),
    minMs:           MIN_STICKY_MS,
    maxMs:           MAX_STICKY_MS,
    baseMs:          BASE_MS,
    inputs: {
      ...getReplicaLagState(),
      p99LatencyMs: getMetrics().transactions.latency.p99 ?? 0,
      errorRate:    Number(slidingErrorRate().toFixed(4)),
    },
  };
}
