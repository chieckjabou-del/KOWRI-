import { Router, type Request, type Response } from "express";
import { launchScopeStatus, launchModulesConfigured } from "../lib/launchScope";
import { alertingStats } from "../lib/alerting";
import { getSwitch, ALL_SWITCHES } from "../lib/killSwitch";

const router = Router();

type HealthPayload = {
  status: "ok";
  service: "kowri-backend";
  timestamp: string;
};

function buildHealthPayload(): HealthPayload {
  return {
    status: "ok",
    service: "kowri-backend",
    timestamp: new Date().toISOString(),
  };
}

router.get("/healthz", (_req: Request, res: Response) => {
  return res.status(200).json(buildHealthPayload());
});

router.get("/health", (_req: Request, res: Response) => {
  return res.status(200).json(buildHealthPayload());
});

// Public, read-only statement of what this deployment will and will not do:
// the launch scope, every financial kill switch's state, and whether outbound
// alerting is wired. No secrets, no internal identifiers.
router.get("/health/launch-scope", (_req: Request, res: Response) => {
  return res.status(200).json({
    environment: process.env.NODE_ENV ?? "development",
    launchModulesConfigured: launchModulesConfigured(),
    modules: launchScopeStatus(),
    killSwitches: ALL_SWITCHES.map((name) => ({ name, state: getSwitch(name).state })),
    alerting: { configured: alertingStats().configured },
    timestamp: new Date().toISOString(),
  });
});

export default router;
