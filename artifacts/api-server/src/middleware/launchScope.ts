import type { Request, Response, NextFunction } from "express";
import { isLaunchModuleEnabled, LAUNCH_MODULE_DESCRIPTIONS, type LaunchModule } from "../lib/launchScope";

// Route-level barrier for an optional module. The service functions behind
// the route carry their own assertModuleEnabled(): this middleware only makes
// the refusal explicit and cheap.
export function launchModule(name: LaunchModule) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (isLaunchModuleEnabled(name)) { next(); return; }
    res.status(503).json({
      error: true,
      code: "MODULE_NOT_IN_LAUNCH_SCOPE",
      module: name,
      message: `${LAUNCH_MODULE_DESCRIPTIONS[name]} — not in the launch scope. Enable with LAUNCH_MODULES=${name} once its controls are proven.`,
    });
  };
}
