import { Router } from "express";
import {
  simulateDatabaseOutage,
  simulateMessageQueueOutage,
  simulateRegionOutage,
  simulateProcessorDowntime,
  runAllFailures,
  type FailureType,
} from "../lib/failureSimulator";

const router = Router();

router.get("/scenarios", (_req, res) => {
  return res.json({
    scenarios: [
      { type: "database_outage",    description: "Simulates primary DB failure with replica failover" },
      { type: "message_queue_outage", description: "Simulates MQ failure with in-memory fallback" },
      { type: "region_outage",      description: "Simulates full region failure with DNS failover" },
      { type: "processor_downtime", description: "Simulates payment processor failure with rerouting" },
    ],
    runAll: "POST /failure-sim/run-all",
  });
});

router.post("/simulate", async (req, res) => {
  const { failureType, region, processorId } = req.body;
  const valid: FailureType[] = ["database_outage", "message_queue_outage", "region_outage", "processor_downtime"];
  if (!failureType || !valid.includes(failureType)) {
    return res.status(400).json({ error: `failureType must be one of: ${valid.join(", ")}` });
  }
  try {
    let result;
    if (failureType === "database_outage")     result = await simulateDatabaseOutage();
    else if (failureType === "message_queue_outage") result = await simulateMessageQueueOutage();
    else if (failureType === "region_outage")  result = await simulateRegionOutage(region ?? "africa");
    else                                       result = await simulateProcessorDowntime(processorId ?? "interswitch-africa");
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: "Simulation failed" });
  }
});

router.post("/run-all", async (_req, res) => {
  try {
    const results = await runAllFailures();
    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: "Full simulation failed" });
  }
});

router.get("/recovery/status", async (_req, res) => {
  return res.json({
    dbPrimary:       "online",
    dbReplicas:      "active",
    messageQueue:    "online",
    regions: {
      africa: "healthy",
      europe: "healthy",
      asia:   "healthy",
    },
    processors: {
      "interswitch-africa": "online",
      flutterwave:          "online",
      "swift-europe":       "online",
    },
    lastCheckAt: new Date(),
  });
});

export default router;
