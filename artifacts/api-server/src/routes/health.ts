import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  return res.json({ status: "ok" });
});

router.get("/health", (_req, res) => {
  return res.json({
    service: "kowri-backend",
    status: "running"
  });
});

export default router;
