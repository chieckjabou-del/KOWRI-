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
import { getLearningEngineState, rehydrateConfidenceMap } from "./learningEngine";
import { getGlobalEvaluatorState, rehydrateGlobalState }  from "./globalEvaluator";

const STATE_KEY = "autopilot";

// ── Write ──────────────────────────────────────────────────────────────────────

export function writeAutopilotState(): void {
  const evalState  = getGlobalEvaluatorState();
  const learnState = getLearningEngineState();

  const value = {
    batchSize:    getBatchSize(),
    mode:         getStrategyMode(),
    confidenceMap: learnState.confidenceMap,
    modeHistory:  evalState.modeHistory,
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
    const result = await db.execute<{ value: Record<string, unknown> }>(sql`
      SELECT value FROM system_state WHERE key = ${STATE_KEY} LIMIT 1
    `);

    const rows = (result as unknown as { rows: { value: Record<string, unknown> }[] }).rows;
    if (!rows || rows.length === 0) {
      console.info("[StateStore] no persisted state — starting with defaults");
      return;
    }

    const state = rows[0].value;

    if (typeof state["batchSize"] === "number") {
      setBatchSize(state["batchSize"]);
    }

    if (typeof state["mode"] === "string") {
      rehydrateStrategyMode(state["mode"] as Parameters<typeof rehydrateStrategyMode>[0]);
    }

    if (state["confidenceMap"] && typeof state["confidenceMap"] === "object") {
      rehydrateConfidenceMap(state["confidenceMap"] as Record<string, number>);
    }

    if (state["modeHistory"] || state["failureCount"] || state["blockedUntil"]) {
      rehydrateGlobalState({
        modeHistory:  (state["modeHistory"]  as string[] | undefined)  ?? [],
        failureCount: (state["failureCount"] as Record<string, number> | undefined) ?? {},
        blockedUntil: (state["blockedUntil"] as Record<string, number> | undefined) ?? {},
      });
    }

    console.info("[StateStore] autopilot state rehydrated from DB");
  } catch (err) {
    console.error("[StateStore] rehydration failed — using defaults:", err);
  }
}
