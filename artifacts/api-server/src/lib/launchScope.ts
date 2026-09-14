// ── Launch scope ─────────────────────────────────────────────────────────────
//
// Which financial modules are open for business. This is the one place where
// that decision lives: every optional module is refused at its routes AND at
// its money-moving service entry points (so no worker, cron, saga or internal
// caller can drive it while it is off), and the list is reported by
// GET /api/health/launch-scope.
//
//   LAUNCH_MODULES=none                   core only
//   LAUNCH_MODULES=tontines,savings       core + these
//   LAUNCH_MODULES=all                    everything (development default)
//   (unset)                               all outside production;
//                                         in production the secrets review
//                                         refuses to start (explicit decision)
//
// Core (always on, governed by kill switches, never by this list):
// registration/OTP, wallets, internal transfers, cash-in under maker-checker,
// KYC, back-office. Everything below is optional at launch.

export const LAUNCH_MODULE_DESCRIPTIONS = {
  credit:           "Loans: disbursement from the platform treasury and repayments",
  agents:           "Agent network: float transfers, cash declarations, agent reconciliation",
  creator_earnings: "Creator communities: declaration of earnings (never credits money)",
  pools:            "Investment pools: invest, redeem, returns distribution",
  insurance:        "Insurance pools: premiums, claims, payouts",
  savings:          "Savings plans: lock, daily yield accrual, maturity",
  tontines:         "Tontines: contributions, payouts, solidarity claims, marketplace",
  fx:               "Currency conversion and diaspora remittances",
  cash_out:         "Cash-out to an external rail (no route exists yet; service guard only)",
} as const;
export type LaunchModule = keyof typeof LAUNCH_MODULE_DESCRIPTIONS;
export const LAUNCH_MODULES = Object.keys(LAUNCH_MODULE_DESCRIPTIONS) as LaunchModule[];

export class ModuleDisabledError extends Error {
  constructor(public readonly module: LaunchModule) {
    super(`Module ${module} is not in the launch scope (LAUNCH_MODULES)`);
    this.name = "ModuleDisabledError";
  }
}

export function launchModulesConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LAUNCH_MODULES !== undefined && env.LAUNCH_MODULES.trim() !== "";
}

function enabledSet(env: NodeJS.ProcessEnv = process.env): Set<LaunchModule> {
  const raw = env.LAUNCH_MODULES?.trim().toLowerCase();
  const all = new Set<LaunchModule>(LAUNCH_MODULES);
  if (raw === undefined || raw === "") return env.NODE_ENV === "production" ? new Set() : all;
  if (raw === "all") return all;
  if (raw === "none") return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter((s): s is LaunchModule => (LAUNCH_MODULES as string[]).includes(s)));
}

export function unknownLaunchModules(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.LAUNCH_MODULES?.trim().toLowerCase();
  if (!raw || raw === "all" || raw === "none") return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s && !(LAUNCH_MODULES as string[]).includes(s));
}

export function isLaunchModuleEnabled(name: LaunchModule): boolean {
  return enabledSet().has(name);
}

// Service-level guard: called at the top of every money-moving function of an
// optional module, so the route middleware is never the only barrier.
export function assertModuleEnabled(name: LaunchModule): void {
  if (!isLaunchModuleEnabled(name)) throw new ModuleDisabledError(name);
}

export function launchScopeStatus(): Array<{ module: LaunchModule; enabled: boolean; description: string }> {
  const enabled = enabledSet();
  return LAUNCH_MODULES.map((module) => ({ module, enabled: enabled.has(module), description: LAUNCH_MODULE_DESCRIPTIONS[module] }));
}
