// ── Kill Switch Store ─────────────────────────────────────────────────────────
//
// Single source of truth for all operational switches.
// Three states:
//   ENABLED     — normal operation; autopilot may fire
//   TRIGGERED   — auto-fired by threshold breach; autopilot may auto-recover
//   FORCED_OFF  — manually locked by operator; only manual lift clears it
//
// All mutations are synchronous (in-memory Map). Audit writes are fire-and-forget.

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
  triggeredBy: string;       // "autopilot" | operator email
  firedAt:     number;       // epoch ms of last state change
  lockedBy?:   string;       // set only in FORCED_OFF
}

// ── Singleton store ───────────────────────────────────────────────────────────
const store = new Map<KillSwitchName, SwitchEntry>();

const ALL_SWITCHES: KillSwitchName[] = [
  "outbound_transfers",
  "settlements",
  "batch_writes",
  "saga_creation",
  "outbox_dispatch",
  "replica_reads",
  "all",
];

// Initialise all switches to ENABLED at module load
for (const name of ALL_SWITCHES) {
  store.set(name, { name, state: "ENABLED", reason: "", triggeredBy: "system", firedAt: Date.now() });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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
  if (sw.state !== "ENABLED") return;        // already blocked — do not reset clock

  const entry: SwitchEntry = { name, state: "TRIGGERED", reason, triggeredBy, firedAt: Date.now() };
  store.set(name, entry);

  console.warn(`[KillSwitch] FIRED   switch=${name} reason=${reason} by=${triggeredBy}`);
  writeAudit("FIRE", name, triggeredBy, { reason, previousState: "ENABLED" });
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
}

/**
 * Guard — throw KillSwitchError if the switch (or "all") is non-ENABLED.
 * Call at the top of any protected operation.
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
