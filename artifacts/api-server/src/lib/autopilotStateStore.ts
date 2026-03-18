// ── Autopilot State Store ──────────────────────────────────────────────────────
//
// Persists the 6 in-memory autopilot fields to a single `system_state` DB row
// so a restart rehydrates the learned state rather than starting blind.
//
// Write contract: fire-and-forget after each cycle (no await, no blocking).
// Read contract:  awaited once at startup before cycle 1.
//
// ROLLBACK: remove rehydrateAutopilotState() from index.ts startup chain;
//           remove writeAutopilotState() from autopilot.ts cycle end;
//           drop the system_state table; delete this file.

import { db }                                     from "@workspace/db";
import { sql }                                    from "drizzle-orm";
import { getBatchSize, setBatchSize }             from "./outboxWorker";
import { getStrategyMode, rehydrateStrategyMode } from "./strategyEngine";
import { getLearningEngineState, rehydrateConfidenceMap, rehydrateSnapshotBuffer, getPendingPrediction, rehydratePendingPrediction } from "./learningEngine";
import { getA1State, rehydrateA1State }                                             from "./selfOptimizer";
import { getGlobalEvaluatorState, rehydrateGlobalState }  from "./globalEvaluator";

const STATE_KEY = "autopilot";

// ── Write ──────────────────────────────────────────────────────────────────────

export function writeAutopilotState(): void {
  const evalState  = getGlobalEvaluatorState();
  const learnState = getLearningEngineState();

  const value = {
    batchSize:    getBatchSize(),
    mode:         getStrategyMode(),
    confidenceMap:  learnState.confidenceMap,
    snapshotBuffer: learnState.snapshotBuffer,
    a1:                getA1State(),
    pendingPrediction: getPendingPrediction(),
    modeHistory:    evalState.modeHistory,
    failureCount: evalState.failureCount,
    // Store remaining cycles (relative) so the value is correct after restart
    // regardless of how many cycles have elapsed in the previous run.
    blockedUntil: Object.fromEntries(
      Object.entries(evalState.suppressions).map(
        ([mode, s]) => [mode, (s as { remainingCycles: number }).remainingCycles],
      ),
    ),
  };

  db.execute(sql`
    INSERT INTO system_state (key, value, updated_at)
    VALUES (${STATE_KEY}, ${JSON.stringify(value)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE
      SET value      = EXCLUDED.value,
          updated_at = NOW()
  `).catch((err) => console.error("[StateStore] write failed:", err));
}

// ── Read / rehydrate ───────────────────────────────────────────────────────────

export async function rehydrateAutopilotState(): Promise<void> {
  try {
    const result = await db.execute<{ value: Record<string, unknown>; updated_at: string }>(sql`
      SELECT value, updated_at FROM system_state WHERE key = ${STATE_KEY} LIMIT 1
    `);

    const rows = (result as unknown as { rows: { value: Record<string, unknown>; updated_at: string }[] }).rows;
    if (!rows || rows.length === 0) {
      console.info("[StateStore] no persisted state — starting with defaults");
      return;
    }

    const row   = rows[0];
    const state = row.value;

    const MAX_STATE_AGE_MS = 10 * 60 * 1000; // 10 minutes
    const stale = Date.now() - new Date(row.updated_at).getTime() > MAX_STATE_AGE_MS;

    if (typeof state["batchSize"] === "number") {
      setBatchSize(state["batchSize"]);
    }

    if (typeof state["mode"] === "string") {
      rehydrateStrategyMode(state["mode"] as Parameters<typeof rehydrateStrategyMode>[0]);
    }

    if (state["confidenceMap"] && typeof state["confidenceMap"] === "object") {
      rehydrateConfidenceMap(state["confidenceMap"] as Record<string, number>);
    }

    if (Array.isArray(state["snapshotBuffer"]) && state["snapshotBuffer"].length) {
      rehydrateSnapshotBuffer(state["snapshotBuffer"] as Parameters<typeof rehydrateSnapshotBuffer>[0]);
    }

    if (!stale && state["a1"] && typeof state["a1"] === "object") {
      rehydrateA1State(state["a1"] as Parameters<typeof rehydrateA1State>[0]);
    }

    if (state["pendingPrediction"] && typeof state["pendingPrediction"] === "object") {
      rehydratePendingPrediction(state["pendingPrediction"] as Parameters<typeof rehydratePendingPrediction>[0]);
    }

    if (state["modeHistory"] || state["failureCount"] || state["blockedUntil"]) {
      rehydrateGlobalState({
        modeHistory:  stale ? [] : ((state["modeHistory"]  as string[] | undefined) ?? []),
        failureCount: stale ? {} : ((state["failureCount"] as Record<string, number> | undefined) ?? {}),
        blockedUntil: stale ? {} : ((state["blockedUntil"] as Record<string, number> | undefined) ?? {}),
      });
    }
    if (stale) {
      console.info("[StateStore] stale state row (>10 min) — modeHistory/blockedUntil/failureCount/a1State discarded");
    }

    console.info("[StateStore] autopilot state rehydrated from DB");
  } catch (err) {
    console.error("[StateStore] rehydration failed — using defaults:", err);
  }
}
