// ── Learning Engine ───────────────────────────────────────────────────────────
//
// Long-term memory layer that runs BEFORE selfOptimize() and AFTER autoHeal().
// It accumulates hourly snapshots, detects recurring per-hour spike patterns, and
// makes a single soft pre-adjustment batch reduction when a known bad hour is
// approaching — before the stress actually manifests.
//
// Responsibilities:
//   • Maintain a 48-slot circular buffer of completed hourly snapshots
//   • Detect recurring patterns: same hour-of-day with high latency ≥ 2 past occurrences
//   • Track per-hour-of-day confidence scores [0.0, 1.0]
//   • Make ONE predictive batch reduction per hour when pattern + confidence ≥ threshold
//   • Evaluate prediction accuracy next cycle and update confidence accordingly
//
// Safety contract:
//   • NEVER re-enables or modifies any kill switch
//   • NEVER exceeds DEFAULT_BATCH_SIZE
//   • NEVER goes below MIN_BATCH_SIZE (5)
//   • Prediction is a "soft adjustment" — does NOT call autoHeal or override it
//   • Once per hour cooldown is enforced via predictedHoursSet (Set of hour keys)
//
// ROLLBACK: remove `await learningEngine(metrics)` from autopilot.ts; delete this file.

import { CollectedMetrics }                               from "./metricsCollector";
import { getBatchSize, setBatchSize, DEFAULT_BATCH_SIZE } from "./outboxWorker";
import { insertIncident }                                  from "./incidentStore";
import { getStrategyMode }                                 from "./strategyEngine";

// ── Constants ─────────────────────────────────────────────────────────────────

const BUFFER_SIZE          = 48;     // hourly slots retained (= 48 h)
const MIN_OCCURRENCES      = 2;      // minimum past high-latency hits to flag recurring_pattern
const CONFIDENCE_INIT      = 0.5;    // starting confidence for a newly seen hour pattern
const CONFIDENCE_THRESHOLD = 0.3;    // below this → predictions for that hour are disabled
const CONFIDENCE_REWARD    = 0.1;    // added when prediction was correct
const CONFIDENCE_PENALTY   = 0.1;    // subtracted when prediction was wrong
const PREDICT_REDUCE_STEP  = 2;      // batch units to shed per predictive adjustment (conservative)
const MIN_BATCH_SIZE        = 5;     // mirror of outboxWorker constant

/** Latency (ms) that counts as "high" for pattern storage/detection purposes.
 *  Intentionally below autoHeal territory (800 ms) so learning acts first.  */
const HIGH_LATENCY_MS = Number(process.env.LEARN_HIGH_LATENCY_MS ?? 200);

// ── Types ─────────────────────────────────────────────────────────────────────

interface HourlySnapshot {
  hourOfDay:   number;    // 0-23
  dateStr:     string;    // "YYYY-MM-DD"  (used for dedup + cleanup)
  avgLatency:  number;
  avgPending:  number;
  avgDlq:      number;
  sampleCount: number;
  wasHighLat:  boolean;   // avgLatency > HIGH_LATENCY_MS
}

interface HourAccumulator {
  hourOfDay: number;
  dateStr:   string;
  sumLat:    number;
  sumPend:   number;
  sumDlq:    number;
  count:     number;
}

interface PendingPrediction {
  hourOfDay: number;
  threshold: number;    // the HIGH_LATENCY_MS in effect when prediction fired
  firedAt:   number;    // Date.now() — used only for logging
}

// ── State ─────────────────────────────────────────────────────────────────────

/** Completed hourly snapshots, oldest-first.  Max BUFFER_SIZE entries. */
const snapshotBuffer: HourlySnapshot[] = [];

/** Accumulates metrics within the current clock hour. */
let accumulator: HourAccumulator | null = null;

/** Per-hour-of-day (0-23) confidence scores. */
const confidenceMap = new Map<number, number>();

/** Single pending prediction awaiting evaluation in the next cycle. */
let pendingPrediction: PendingPrediction | null = null;

/** Set of "YYYY-MM-DDTHH" strings; prevents double-firing within the same clock hour. */
const predictedHoursSet = new Set<string>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowParts(): { hourOfDay: number; dateStr: string; hourKey: string } {
  const now        = new Date();
  const hourOfDay  = now.getHours();
  const dateStr    = now.toISOString().slice(0, 10);          // "YYYY-MM-DD"
  const hourKey    = `${dateStr}T${String(hourOfDay).padStart(2, "0")}`;
  return { hourOfDay, dateStr, hourKey };
}

function getConfidence(hourOfDay: number): number {
  return confidenceMap.get(hourOfDay) ?? CONFIDENCE_INIT;
}

function adjustConfidence(hourOfDay: number, delta: number): void {
  const current = getConfidence(hourOfDay);
  confidenceMap.set(hourOfDay, Math.min(1.0, Math.max(0.0, current + delta)));
}

// ── Accumulator flush ─────────────────────────────────────────────────────────

function flushAccumulator(): void {
  if (!accumulator || accumulator.count === 0) return;

  const { hourOfDay, dateStr, sumLat, sumPend, sumDlq, count } = accumulator;
  const avgLatency  = sumLat  / count;
  const avgPending  = sumPend / count;
  const avgDlq      = sumDlq  / count;
  const wasHighLat  = avgLatency > HIGH_LATENCY_MS;

  // Dedup: if a snapshot for this hour+date already exists, replace it so that
  // a process restart within the same hour doesn't generate duplicate entries.
  const existingIdx = snapshotBuffer.findIndex(
    s => s.hourOfDay === hourOfDay && s.dateStr === dateStr,
  );
  const snapshot: HourlySnapshot = {
    hourOfDay, dateStr, avgLatency, avgPending, avgDlq, sampleCount: count, wasHighLat,
  };

  if (existingIdx !== -1) {
    snapshotBuffer[existingIdx] = snapshot;
  } else {
    snapshotBuffer.push(snapshot);
    // Evict oldest entry if buffer is full.
    if (snapshotBuffer.length > BUFFER_SIZE) snapshotBuffer.shift();
  }

  accumulator = null;

  // Clean predictedHoursSet: remove keys older than 48 h.
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  for (const key of predictedHoursSet) {
    // Key format: "YYYY-MM-DDTHH"
    const ts = new Date(`${key.slice(0, 10)}T${key.slice(11, 13)}:00:00Z`).getTime();
    if (ts < cutoff) predictedHoursSet.delete(key);
  }
}

// ── Pattern detection ─────────────────────────────────────────────────────────

interface PatternResult {
  isRecurring:  boolean;
  occurrences:  number;
  avgHighLat:   number;
}

function detectPattern(hourOfDay: number): PatternResult {
  const entries = snapshotBuffer.filter(s => s.hourOfDay === hourOfDay && s.wasHighLat);
  if (entries.length < MIN_OCCURRENCES) {
    return { isRecurring: false, occurrences: entries.length, avgHighLat: 0 };
  }
  const avgHighLat = entries.reduce((sum, e) => sum + e.avgLatency, 0) / entries.length;
  return { isRecurring: true, occurrences: entries.length, avgHighLat };
}

// ── Prediction evaluation ─────────────────────────────────────────────────────

function evaluatePendingPrediction(currentLatency: number): void {
  if (!pendingPrediction) return;

  const { hourOfDay, threshold } = pendingPrediction;
  const correct = currentLatency < threshold;

  if (correct) {
    adjustConfidence(hourOfDay, +CONFIDENCE_REWARD);
    console.info(
      `[LearningEngine] prediction CORRECT hour=${hourOfDay} latency=${currentLatency}ms ` +
      `confidence=${getConfidence(hourOfDay).toFixed(2)}`,
    );
  } else {
    adjustConfidence(hourOfDay, -CONFIDENCE_PENALTY);
    console.warn(
      `[LearningEngine] prediction WRONG hour=${hourOfDay} latency=${currentLatency}ms ` +
      `confidence=${getConfidence(hourOfDay).toFixed(2)}`,
    );
  }

  pendingPrediction = null;
}

// ── Observability ─────────────────────────────────────────────────────────────

export function getLearningEngineState() {
  const patterns: Record<number, PatternResult & { confidence: number }> = {};
  for (let h = 0; h < 24; h++) {
    const p = detectPattern(h);
    if (p.occurrences > 0) {
      patterns[h] = { ...p, confidence: getConfidence(h) };
    }
  }
  return {
    snapshotsStored:   snapshotBuffer.length,
    bufferCapacity:    BUFFER_SIZE,
    accumulatorActive: accumulator !== null,
    pendingPrediction,
    patterns,
    confidenceMap:     Object.fromEntries(confidenceMap),
  };
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function learningEngine(metrics: CollectedMetrics): Promise<void> {
  const { hourOfDay, dateStr, hourKey } = nowParts();

  // Step 1 — evaluate any prediction we made last cycle BEFORE processing new data.
  evaluatePendingPrediction(metrics.db_latency);

  // Step 2 — if accumulator is for a different hour, flush it first.
  if (accumulator && (accumulator.hourOfDay !== hourOfDay || accumulator.dateStr !== dateStr)) {
    flushAccumulator();
  }

  // Step 3 — ensure accumulator exists for the current hour.
  if (!accumulator) {
    accumulator = { hourOfDay, dateStr, sumLat: 0, sumPend: 0, sumDlq: 0, count: 0 };
  }

  // Step 4 — accumulate this cycle's metrics.
  accumulator.sumLat  += metrics.db_latency;
  accumulator.sumPend += metrics.outbox_pending;
  accumulator.sumDlq  += metrics.dlq_rate;
  accumulator.count   += 1;

  // Step 5 — check whether the current hour has a recurring pattern.
  //          Need at least one completed hour in the buffer before predicting.
  if (snapshotBuffer.length === 0) return;

  const pattern    = detectPattern(hourOfDay);
  const confidence = getConfidence(hourOfDay);

  if (!pattern.isRecurring)           return;   // no recurring pattern for this hour
  if (confidence < CONFIDENCE_THRESHOLD) return;  // confidence too low — predictions disabled
  if (predictedHoursSet.has(hourKey)) return;   // already adjusted this hour

  // Step 6 — make the predictive pre-adjustment.
  const currentBatch = getBatchSize();
  if (currentBatch <= MIN_BATCH_SIZE) return;   // already at floor — nothing to reduce

  // If the strategy engine already has the system in LATENCY_FIRST mode, apply a
  // lighter pre-adjustment (1 unit instead of 2) — the strategy layer is already
  // handling the latency concern more aggressively, so we avoid double-punishing.
  const effectiveStep = getStrategyMode() === "LATENCY_FIRST"
    ? Math.max(1, PREDICT_REDUCE_STEP - 1)
    : PREDICT_REDUCE_STEP;

  const after = Math.max(MIN_BATCH_SIZE, currentBatch - effectiveStep);
  if (after >= currentBatch) return;             // no room (shouldn't happen given guard above)

  setBatchSize(after);
  predictedHoursSet.add(hourKey);
  pendingPrediction = { hourOfDay, threshold: HIGH_LATENCY_MS, firedAt: Date.now() };

  const result =
    `pattern_detected hour=${hourOfDay} occurrences=${pattern.occurrences} ` +
    `avg_high_lat=${pattern.avgHighLat.toFixed(1)}ms confidence=${confidence.toFixed(2)} ` +
    `decision=reduce_batch batchSize=${currentBatch}→${after} ` +
    `mode=${getStrategyMode()} step=${effectiveStep}`;

  console.info(`[LearningEngine] predictive_adjustment: ${result}`);
  await insertIncident({ type: "learning_engine", action: "predictive_adjustment", result });
}
