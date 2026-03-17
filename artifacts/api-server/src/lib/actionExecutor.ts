// ── Action Executor ───────────────────────────────────────────────────────────
//
// Implements the three autopilot actions:
//   1. disableTransfers   — fires outbound_transfers kill switch
//   2. pauseOutboxWorker  — fires outbox_dispatch switch + stops worker interval
//   3. forcePrimaryReads  — fires replica_reads switch + overrides dbRouter
//
// Each action follows the same pattern:
//   a. Guard: skip if already blocked or FORCED_OFF
//   b. Fire kill switch (records state + audit)
//   c. Apply side-effect to underlying service
//   d. Log outcome
//
// Rollback reverses both the switch state and the side-effect.
// Side-effects are ordered: safest-first on fire, reverse order on rollback.

import { fire, autoRecover, manualLift, getSwitch, KillSwitchName } from "./killSwitch";
import { stopOutboxWorker, startOutboxWorker }                       from "./outboxWorker";
import { overrideReplicaHealthy }                                    from "./dbRouter";

// ── Execution context ─────────────────────────────────────────────────────────
export interface ActionContext {
  triggeredBy: string;        // "autopilot" | operator identifier
  reason:      string;        // human-readable cause
  metricValue?: number | string;
}

// ── Result ────────────────────────────────────────────────────────────────────
export interface ActionResult {
  action:    string;
  switch:    KillSwitchName;
  outcome:   "fired" | "skipped" | "recovered" | "error";
  reason?:   string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION 1 — Disable Transfers
// Blocks all outbound P2P and merchant payouts.
// Side-effect: none beyond the kill switch (processTransfer calls guard()).
// ─────────────────────────────────────────────────────────────────────────────

export function disableTransfers(ctx: ActionContext): ActionResult {
  const sw = getSwitch("outbound_transfers");

  if (sw.state !== "ENABLED") {
    return { action: "disableTransfers", switch: "outbound_transfers", outcome: "skipped",
             reason: `already ${sw.state}` };
  }

  fire("outbound_transfers", ctx.reason, ctx.triggeredBy);
  console.warn(`[ActionExecutor] disableTransfers — ${ctx.reason} (by=${ctx.triggeredBy})`);

  return { action: "disableTransfers", switch: "outbound_transfers", outcome: "fired" };
}

export function enableTransfers(operator: string): ActionResult {
  const sw = getSwitch("outbound_transfers");

  if (sw.state === "FORCED_OFF") {
    return { action: "enableTransfers", switch: "outbound_transfers", outcome: "skipped",
             reason: "FORCED_OFF — use /admin/kill-switches/outbound_transfers/lift" };
  }

  autoRecover("outbound_transfers");
  console.info(`[ActionExecutor] enableTransfers — recovered by ${operator}`);

  return { action: "enableTransfers", switch: "outbound_transfers", outcome: "recovered" };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION 2 — Pause Outbox Worker
// Stops the interval timer so no outbox batches are dispatched.
// Fire order: switch first (blocks new dispatch attempts), then stop interval.
// Rollback: start interval first, then lift switch.
// ─────────────────────────────────────────────────────────────────────────────

export function pauseOutboxWorker(ctx: ActionContext): ActionResult {
  const sw = getSwitch("outbox_dispatch");

  if (sw.state !== "ENABLED") {
    return { action: "pauseOutboxWorker", switch: "outbox_dispatch", outcome: "skipped",
             reason: `already ${sw.state}` };
  }

  // 1. Block first — no new batches start after this line
  fire("outbox_dispatch", ctx.reason, ctx.triggeredBy);

  // 2. Stop the interval — in-flight batch runs to completion naturally
  stopOutboxWorker();

  console.warn(`[ActionExecutor] pauseOutboxWorker — ${ctx.reason} (by=${ctx.triggeredBy})`);

  return { action: "pauseOutboxWorker", switch: "outbox_dispatch", outcome: "fired" };
}

export function resumeOutboxWorker(operator: string): ActionResult {
  const sw = getSwitch("outbox_dispatch");

  if (sw.state === "FORCED_OFF") {
    return { action: "resumeOutboxWorker", switch: "outbox_dispatch", outcome: "skipped",
             reason: "FORCED_OFF — use /admin/kill-switches/outbox_dispatch/lift" };
  }

  // 1. Restart interval before lifting switch so first batch is safe
  startOutboxWorker();

  // 2. Lift switch
  autoRecover("outbox_dispatch");

  console.info(`[ActionExecutor] resumeOutboxWorker — recovered by ${operator}`);

  return { action: "resumeOutboxWorker", switch: "outbox_dispatch", outcome: "recovered" };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION 3 — Force Primary Reads
// Overrides the dbRouter replica health flag so getReadDb() always returns
// the primary connection, regardless of measured lag.
// Fire order: switch first, then override.
// Rollback: restore dbRouter flag first, then lift switch.
// ─────────────────────────────────────────────────────────────────────────────

export function forcePrimaryReads(ctx: ActionContext): ActionResult {
  const sw = getSwitch("replica_reads");

  if (sw.state !== "ENABLED") {
    return { action: "forcePrimaryReads", switch: "replica_reads", outcome: "skipped",
             reason: `already ${sw.state}` };
  }

  // 1. Block replica path in kill switch layer
  fire("replica_reads", ctx.reason, ctx.triggeredBy);

  // 2. Override dbRouter — forces getReadDb() to primary immediately
  overrideReplicaHealthy(false);

  console.warn(`[ActionExecutor] forcePrimaryReads — ${ctx.reason} (by=${ctx.triggeredBy})`);

  return { action: "forcePrimaryReads", switch: "replica_reads", outcome: "fired" };
}

export function restoreReplicaReads(operator: string): ActionResult {
  const sw = getSwitch("replica_reads");

  if (sw.state === "FORCED_OFF") {
    return { action: "restoreReplicaReads", switch: "replica_reads", outcome: "skipped",
             reason: "FORCED_OFF — use /admin/kill-switches/replica_reads/lift" };
  }

  // 1. Restore dbRouter — re-enables lag-based routing
  overrideReplicaHealthy(null);

  // 2. Lift switch
  autoRecover("replica_reads");

  console.info(`[ActionExecutor] restoreReplicaReads — recovered by ${operator}`);

  return { action: "restoreReplicaReads", switch: "replica_reads", outcome: "recovered" };
}

// ── Universal rollback dispatcher ─────────────────────────────────────────────

export function rollback(switchName: KillSwitchName, operator: string): ActionResult {
  switch (switchName) {
    case "outbound_transfers": return enableTransfers(operator);
    case "outbox_dispatch":    return resumeOutboxWorker(operator);
    case "replica_reads":      return restoreReplicaReads(operator);
    default:
      manualLift(switchName, operator);
      return { action: "rollback", switch: switchName, outcome: "recovered" };
  }
}

// ── Batch executor (used by autopilot rules engine) ───────────────────────────
//
// Executes an array of action strings from a rule definition.
// Stops on first error; returns all results including the stopping error.

export async function executeActions(
  actions: string[],
  ctx: ActionContext,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  for (const action of actions) {
    try {
      let result: ActionResult;

      if      (action === "fire:outbound_transfers") result = disableTransfers(ctx);
      else if (action === "fire:outbox_dispatch")    result = pauseOutboxWorker(ctx);
      else if (action === "fire:replica_reads")      result = forcePrimaryReads(ctx);
      else if (action === "fire:settlements")        result = disableTransfers(ctx);   // shares outbound guard
      else if (action === "fire:batch_writes")       result = { action, switch: "batch_writes", outcome: "fired" };
      else if (action === "fire:saga_creation")      result = { action, switch: "saga_creation", outcome: "fired" };
      else if (action === "fire:all")                result = { action, switch: "all", outcome: "fired" };
      else if (action.startsWith("alert:"))         { console.warn(`[ActionExecutor] ALERT ${action} ctx=${JSON.stringify(ctx)}`); continue; }
      else if (action.startsWith("log:"))           { console.info(`[ActionExecutor] LOG ${action}`); continue; }
      else                                          { console.warn(`[ActionExecutor] unknown action: ${action}`); continue; }

      // For raw switch fires (batch_writes, saga_creation, all) not covered by dedicated functions:
      if (["fire:batch_writes","fire:saga_creation","fire:all"].includes(action)) {
        const swName = action.replace("fire:", "") as KillSwitchName;
        const sw = getSwitch(swName);
        if (sw.state === "ENABLED") fire(swName, ctx.reason, ctx.triggeredBy);
      }

      results.push(result);
    } catch (err) {
      results.push({ action, switch: "all", outcome: "error", reason: String(err) });
      break;
    }
  }

  return results;
}
