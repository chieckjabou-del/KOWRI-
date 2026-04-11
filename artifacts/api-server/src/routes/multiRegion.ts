import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

const REGIONS = [
  {
    id:       "africa-west",
    name:     "Africa West",
    zone:     "africa",
    primary:  true,
    endpoints: ["dakar.kowri.io", "abidjan.kowri.io"],
    currencies: ["XOF", "XAF", "GHS", "NGN"],
    replicationLagMs: 0,
    readReplicaCount: 2,
    status: "healthy",
  },
  {
    id:       "africa-east",
    name:     "Africa East",
    zone:     "africa",
    primary:  false,
    endpoints: ["nairobi.kowri.io", "kampala.kowri.io"],
    currencies: ["KES", "UGX", "TZS"],
    replicationLagMs: 45,
    readReplicaCount: 2,
    status: "healthy",
  },
  {
    id:       "europe-west",
    name:     "Europe West",
    zone:     "europe",
    primary:  false,
    endpoints: ["paris.kowri.io", "london.kowri.io"],
    currencies: ["EUR", "GBP", "CHF"],
    replicationLagMs: 120,
    readReplicaCount: 3,
    status: "healthy",
  },
  {
    id:       "asia-pacific",
    name:     "Asia Pacific",
    zone:     "asia",
    primary:  false,
    endpoints: ["singapore.kowri.io", "mumbai.kowri.io"],
    currencies: ["USD", "SGD", "INR", "CNY"],
    replicationLagMs: 210,
    readReplicaCount: 2,
    status: "healthy",
  },
];

const READ_REPLICAS = REGIONS.flatMap(r =>
  Array.from({ length: r.readReplicaCount }, (_, i) => ({
    id:           `${r.id}-replica-${i + 1}`,
    region:       r.id,
    zone:         r.zone,
    lagMs:        r.replicationLagMs + Math.floor(Math.random() * 20),
    status:       "active",
    role:         "read_replica",
    queryLoad:    Math.floor(Math.random() * 60) + 10,
  }))
);

router.get("/regions", (_req, res) => {
  return res.json({ regions: REGIONS, count: REGIONS.length, zones: ["africa", "europe", "asia"] });
});

router.get("/regions/:regionId", (req, res) => {
  const region = REGIONS.find(r => r.id === req.params.regionId);
  if (!region) return res.status(404).json({ error: "Region not found" });
  return res.json(region);
});

router.get("/replicas", (_req, res) => {
  return res.json({ replicas: READ_REPLICAS, count: READ_REPLICAS.length });
});

router.get("/routing", (req, res) => {
  const { zone, currency } = req.query;
  const eligible = REGIONS.filter(r => {
    if (zone && r.zone !== zone) return false;
    if (currency && !r.currencies.includes(currency as string)) return false;
    return r.status === "healthy";
  });
  const primary   = eligible.find(r => r.primary) ?? eligible[0];
  const secondary = eligible.filter(r => r !== primary).slice(0, 2);
  return res.json({
    selected:     primary ?? null,
    alternatives: secondary,
    strategy:     "latency_aware",
    routedBy:     zone ?? "default",
  });
});

router.post("/failover", (req, res) => {
  const { fromRegion, toRegion } = req.body;
  if (!fromRegion || !toRegion) return res.status(400).json({ error: "fromRegion and toRegion required" });
  const from = REGIONS.find(r => r.id === fromRegion);
  const to   = REGIONS.find(r => r.id === toRegion);
  if (!from || !to) return res.status(404).json({ error: "Region not found" });
  return res.json({
    failoverInitiated: true,
    fromRegion,
    toRegion,
    estimatedCutoverMs: 5000,
    steps: [
      "DNS TTL reduced to 30s",
      "Read traffic shifted to target region",
      "Write fencing applied on source",
      "WAL replay verified on target",
      "DNS updated to point to target",
    ],
  });
});

router.get("/replication/status", (_req, res) => {
  const status = REGIONS.map(r => ({
    regionId:  r.id,
    zone:      r.zone,
    lagMs:     r.replicationLagMs,
    replicaCount: r.readReplicaCount,
    status:    r.replicationLagMs < 100 ? "healthy" : r.replicationLagMs < 500 ? "lagging" : "critical",
  }));
  return res.json({
    replication: status,
    overallHealth: status.every(s => s.status === "healthy") ? "healthy" : "degraded",
    primaryRegion: "africa-west",
  });
});

export default router;
