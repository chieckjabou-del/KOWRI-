// ── Kill Switch Store ─────────────────────────────────────────────────────────
//
// Three states:
//   ENABLED     — normal operation; autopilot may fire
//   TRIGGERED   — auto-fired by threshold breach; autopilot may auto-recover
//   FORCED_OFF  — manually locked by operator; only manual lift clears it
//
// Persistence model (write-through cache):
//   • DB (kill_switches table) is the source of truth.
//   • In-memory Map is the hot read path so guard() stays synchronous.
//   • All mutations write to the cache first, then persist to DB fire-and-forget.
//   • On restart, initKillSwitches() hydrates the cache from DB.
//   • DB schema: enabled=true → ENABLED; enabled=false → TRIGGERED or FORCED_OFF.
//     On cold start, enabled=false is conservatively loaded as FORCED_OFF.
//
// ROLLBACK: revert to previous version which removes all DB imports/calls.

import { db } from "@workspace/db";
import { killSwitchesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { audit } from "./auditLogger";

export type KillSwitchName =
  | "outbound_transfers"
  | "settlements"
  | "batch_writes"
  | "saga_creation"
  | "outbox_dispatch"
  | "replica_reads"
  | "all";

export type KillSwitchState = "ENABLED" | "TRIGGERED" | "FORCED_OFF";

export class KillSwitchError extends Error {
  constructor(
    public readonly switchName: KillSwitchName,
    public readonly state: KillSwitchState,
    public readonly reason: string,
  ) {
    super(`[KillSwitch] Operation blocked — switch=${switchName} state=${state} reason=${reason}`);
    this.name = "KillSwitchError";
  }
}

interface SwitchEntry {
  name:        KillSwitchName;
  state:       KillSwitchState;
  reason:      string;
  triggeredBy: string;
  firedAt:     number;
  lockedBy?:   string;
}

// ── Singleton in-memory cache ─────────────────────────────────────────────────
const store = new Map<KillSwitchName, SwitchEntry>();

export const ALL_SWITCHES: KillSwitchName[] = [
  "outbound_transfers",
  "settlements",
  "batch_writes",
  "saga_creation",
  "outbox_dispatch",
  "replica_reads",
  "all",
];

// Seed cache with ENABLED defaults synchronously so guard() works before
// initKillSwitches() resolves (e.g. during early startup).
for (const name of ALL_SWITCHES) {
  store.set(name, { name, state: "ENABLED", reason: "", triggeredBy: "system", firedAt: Date.now() });
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/** Upsert a switch row into DB.  Fire-and-forget — never blocks callers. */
function persistSwitch(name: KillSwitchName, state: KillSwitchState, reason: string): void {
  db.execute(sql`
    INSERT INTO kill_switches (name, enabled, reason, updated_at)
    VALUES (${name}, ${state === "ENABLED"}, ${reason}, now())
    ON CONFLICT (name) DO UPDATE
      SET enabled    = EXCLUDED.enabled,
          reason     = EXCLUDED.reason,
          updated_at = now()
  `).catch((err) => console.error("[KillSwitch] persist failed:", err));
}

// ── Startup hydration ─────────────────────────────────────────────────────────

/**
 * Must be called once at server startup (after DB is ready).
 * Seeds any missing rows with safe defaults, then hydrates the in-memory cache
 * from DB state so operator-set switches survive restarts.
 */
export async function initKillSwitches(): Promise<void> {
  // Seed missing rows — ON CONFLICT DO NOTHING preserves operator-set state.
  await db.execute(sql`
    INSERT INTO kill_switches (name, enabled, reason, updated_at)
    VALUES
      ${sql.join(
        ALL_SWITCHES.map(n => sql`(${n}, true, '', now())`),
        sql`, `,
      )}
    ON CONFLICT (name) DO NOTHING
  `);

  // Hydrate cache from DB.
  const rows = await db.select().from(killSwitchesTable);
  for (const row of rows) {
    const name = row.name as KillSwitchName;
    if (!ALL_SWITCHES.includes(name)) continue;
    store.set(name, {
      name,
      // enabled=false on restart → FORCED_OFF (conservative; requires manual lift).
      state:       row.enabled ? "ENABLED" : "FORCED_OFF",
      reason:      row.reason ?? "",
      triggeredBy: "db",
      firedAt:     row.updatedAt.getTime(),
    });
  }

  console.info("[KillSwitch] initialised from DB —",
    rows.filter(r => !r.enabled).map(r => r.name).join(", ") || "all ENABLED",
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function get(name: KillSwitchName): SwitchEntry {
  return store.get(name)!;
}

function writeAudit(action: string, name: KillSwitchName, actor: string, meta: Record<string, unknown>) {
  audit({
    action: "transaction.state_changed" as any,
    entity: "kill_switch",
    entityId: name,
    actor,
    metadata: { action, ...meta },
  }).catch(() => {});
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Fire a switch — moves ENABLED → TRIGGERED. No-op if already TRIGGERED or FORCED_OFF. */
export function fire(name: KillSwitchName, reason: string, triggeredBy = "autopilot"): void {
  const sw = get(name);
  if (sw.state !== "ENABLED") return;

  const entry: SwitchEntry = { name, state: "TRIGGERED", reason, triggeredBy, firedAt: Date.now() };
  store.set(name, entry);

  console.warn(`[KillSwitch] FIRED   switch=${name} reason=${reason} by=${triggeredBy}`);
  writeAudit("FIRE", name, triggeredBy, { reason, previousState: "ENABLED" });
  persistSwitch(name, "TRIGGERED", reason);
}

/** Operator manually locks a switch. Cannot be undone by autopilot. */
export function forceOff(name: KillSwitchName, operator: string, reason: string): void {
  const prev = get(name).state;
  const entry: SwitchEntry = {
    name, state: "FORCED_OFF", reason, triggeredBy: operator, firedAt: Date.now(), lockedBy: operator,
  };
  store.set(name, entry);

  console.warn(`[KillSwitch] FORCED_OFF switch=${name} reason=${reason} by=${operator}`);
  writeAudit("FORCE_OFF", name, operator, { reason, previousState: prev });
  persistSwitch(name, "FORCED_OFF", reason);
}

/**
 * Auto-recover — moves TRIGGERED → ENABLED.
 * Silently ignores FORCED_OFF (human must call manualLift).
 */
export function autoRecover(name: KillSwitchName): void {
  const sw = get(name);
  if (sw.state !== "TRIGGERED") return;

  store.set(name, { ...sw, state: "ENABLED", reason: "", firedAt: Date.now() });
  console.info(`[KillSwitch] RECOVERED switch=${name}`);
  writeAudit("AUTO_RECOVER", name, "autopilot", {});
  persistSwitch(name, "ENABLED", "");
}

/**
 * Manual lift — clears any state back to ENABLED.
 * The only path out of FORCED_OFF.
 */
export function manualLift(name: KillSwitchName, operator: string): void {
  const prev = get(name).state;
  store.set(name, { name, state: "ENABLED", reason: "", triggeredBy: operator, firedAt: Date.now() });
  console.info(`[KillSwitch] LIFTED  switch=${name} by=${operator} previousState=${prev}`);
  writeAudit("MANUAL_LIFT", name, operator, { previousState: prev });
  persistSwitch(name, "ENABLED", "");
}

/**
 * Guard — throw KillSwitchError if the switch (or "all") is non-ENABLED.
 * Reads only from in-memory cache — always synchronous, never blocks.
 */
export function guard(name: KillSwitchName): void {
  const globalSw = get("all");
  if (globalSw.state !== "ENABLED") {
    throw new KillSwitchError("all", globalSw.state, globalSw.reason);
  }
  if (name === "all") return;
  const sw = get(name);
  if (sw.state !== "ENABLED") {
    throw new KillSwitchError(name, sw.state, sw.reason);
  }
}

/** Returns current state of one switch. */
export function getSwitch(name: KillSwitchName): SwitchEntry {
  return { ...get(name) };
}

/** Returns snapshot of all switches. */
export function getAllSwitches(): SwitchEntry[] {
  return ALL_SWITCHES.map(n => ({ ...get(n) }));
}
