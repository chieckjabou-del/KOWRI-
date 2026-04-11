import { Router } from "express";
import { tracer } from "../lib/tracer";
import { SERVICES } from "../services/index";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const traceId = req.query.traceId as string | undefined;
    const graph   = await tracer.getCallGraph(traceId);

    return res.json({
      ...graph,
      services:    SERVICES,
      tracingMode: "distributed",
      sampleRate:  1.0,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch tracing data" });
  }
});

router.post("/trace", async (req, res) => {
  try {
    const { service = "api-gateway", operation = "test_trace" } = req.body ?? {};
    const ctx = tracer.startSpan(service, operation);
    await new Promise((r) => setTimeout(r, 5));
    await tracer.finishSpan(ctx, "ok", { test: true });
    return res.json({ traceId: ctx.traceId, spanId: ctx.spanId, service, operation });
  } catch (err) {
    return res.status(500).json({ error: "Trace failed" });
  }
});

export default router;
