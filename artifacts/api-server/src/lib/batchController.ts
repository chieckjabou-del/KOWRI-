// ── Batch Controller ──────────────────────────────────────────────────────────
//
// Cycle-level mutex for batch-size changes.
//
// Problem it solves:
//   healingEngine, selfOptimize, and learningEngine can all call setBatchSize()
//   in the same 5-second autopilot cycle.  Without coordination, a latency spike
//   triggers a 50% emergency reduction (healingEngine) AND a 10–15% reduction
//   (selfOptimize) AND a predictive reduction (learningEngine) — all in one pass.
//
// Contract:
//   • requestBatchChange() is the only permitted entry point for setBatchSize.
//   • First caller per cycle wins; all subsequent callers are skipped and logged.
//   • resetBatchLock() must be called at the START of each autopilot cycle,
//     before any layer runs.  autopilot.ts owns this.
//
// ROLLBACK: remove resetBatchLock() from autopilot.ts; revert each layer to
//           call setBatchSize() directly; delete this file.

import { getBatchSize, setBatchSize } from "./outboxWorker";

let lockedBy:    string | null = null;
let skipCount:   number        = 0;
let batchBefore: number | null = null;
let batchAfter:  number | null = null;

/**
 * Attempt to change the batch size this cycle.
 *
 * @param source   Human-readable caller label — logged on skip.
 * @param newSize  Absolute target batch size (already clamped by caller).
 * @returns true if the change was applied; false if another layer already
 *          adjusted batch size this cycle.
 */
export function requestBatchChange(source: string, newSize: number): boolean {
  if (lockedBy !== null) {
    skipCount++;
    console.info(`[BatchController] ${source} skipped — batch already adjusted this cycle`);
    return false;
  }

  batchBefore = getBatchSize();
  batchAfter  = newSize;
  lockedBy    = source;
  skipCount   = 0;
  setBatchSize(newSize);
  return true;
}

/**
 * Reset the per-cycle lock.  Called once at the top of each autopilot cycle.
 */
export function resetBatchLock(): void {
  lockedBy    = null;
  skipCount   = 0;
  batchBefore = null;
  batchAfter  = null;
}

/**
 * Read-only snapshot for observability — zero lock-state changes.
 */
export function getBatchControllerState(): {
  lockedBy:      string | null;
  skipsThisCycle: number;
  batchBefore:   number | null;
  batchAfter:    number | null;
} {
  return { lockedBy, skipsThisCycle: skipCount, batchBefore, batchAfter };
}
