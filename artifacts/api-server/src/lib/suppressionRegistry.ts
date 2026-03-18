// ── Suppression Registry ──────────────────────────────────────────────────────
//
// Owns StrategyMode, cycleCount, blockedUntil, and isModeSuppressed.
//
// Extracted from globalEvaluator.ts to break the circular import between
// globalEvaluator ↔ strategyEngine.  Both now import from this file; neither
// imports from the other.
//
//   globalEvaluator imports: StrategyMode, incrementCycle, getCycleCount,
//                            suppressMode, clearSuppressions, getBlockedUntil
//   strategyEngine  imports: StrategyMode, isModeSuppressed

// ── Type ──────────────────────────────────────────────────────────────────────

export type StrategyMode = "LATENCY_FIRST" | "THROUGHPUT_FIRST" | "BALANCED";

// ── State ─────────────────────────────────────────────────────────────────────

/** Global monotonic cycle counter.  Incremented at the top of each globalEvaluator invocation. */
let cycleCount = 0;

/** Cycle count at which suppression expires (exclusive: suppressed while cycleCount < value). */
const blockedUntil = new Map<StrategyMode, number>();

// ── API for globalEvaluator ───────────────────────────────────────────────────

export function incrementCycle(): number {
  return ++cycleCount;
}

export function getCycleCount(): number {
  return cycleCount;
}

export function suppressMode(mode: StrategyMode, until: number): void {
  blockedUntil.set(mode, until);
}

export function clearSuppressions(): void {
  blockedUntil.clear();
}

export function getBlockedUntil(): ReadonlyMap<StrategyMode, number> {
  return blockedUntil;
}

// ── API for strategyEngine ────────────────────────────────────────────────────

/**
 * Returns true when globalEvaluator has suppressed `mode` because it was
 * judged ineffective.  Called synchronously by strategyEngine before mode
 * selection.
 */
export function isModeSuppressed(mode: StrategyMode): boolean {
  const expiry = blockedUntil.get(mode);
  return expiry !== undefined && cycleCount < expiry;
}
