import { Router, type Request, type Response } from "express";

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

export default router;
