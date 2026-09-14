import type { Request, Response, NextFunction } from "express";

// Modules that demonstrate a capability without a real backing (no ledger
// entries, no external system, in-memory state). They stay in the codebase
// and in the development/test environment, but are switched off in
// production until each one is wired to something real.
//
//   EXPERIMENTAL_MODULES=all                 enable every module
//   EXPERIMENTAL_MODULES=none                disable every module
//   EXPERIMENTAL_MODULES=settlements,regions enable only these
//   (unset)                                  all on outside production, none in production

export const EXPERIMENTAL_MODULES = {
  settlements:  "Partner settlements: statuses change without any ledger movement",
  clearing:     "Clearing batches: netting is computed but nothing is booked",
  connectors:   "Payment connectors: stubs that simulate provider responses",
  regions:      "Multi-region routing: in-memory topology, no real replication",
  "failure-sim": "Failure simulation: injects faults into the running process",
} as const;
export type ExperimentalModule = keyof typeof EXPERIMENTAL_MODULES;

function enabledSet(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.EXPERIMENTAL_MODULES?.trim().toLowerCase();
  const all = new Set<string>(Object.keys(EXPERIMENTAL_MODULES));
  if (raw === undefined || raw === "") return env.NODE_ENV === "production" ? new Set() : all;
  if (raw === "all") return all;
  if (raw === "none") return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter((s) => all.has(s)));
}

export function isModuleEnabled(name: ExperimentalModule): boolean {
  return enabledSet().has(name);
}

export function experimentalModuleStatus(): Array<{ module: string; enabled: boolean; description: string }> {
  const enabled = enabledSet();
  return (Object.keys(EXPERIMENTAL_MODULES) as ExperimentalModule[]).map((module) => ({
    module, enabled: enabled.has(module), description: EXPERIMENTAL_MODULES[module],
  }));
}

export function experimental(name: ExperimentalModule) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (isModuleEnabled(name)) { next(); return; }
    res.status(503).json({
      error: "Module disabled",
      code: "MODULE_DISABLED",
      module: name,
      message: `${EXPERIMENTAL_MODULES[name]}. Enable it with EXPERIMENTAL_MODULES=${name} once it is backed by a real system.`,
    });
  };
}
