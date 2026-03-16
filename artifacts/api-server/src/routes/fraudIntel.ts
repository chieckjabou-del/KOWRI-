import { Router } from "express";
import {
  getNetworkGraph,
  getTopRiskWallets,
  computeFraudScore,
  detectBehavioralAnomalies,
  detectCrossWalletVelocity,
  recordNetworkEdge,
  ensureNode,
} from "../lib/fraudIntelligence";
import { db } from "@workspace/db";
import { fraudNetworkNodesTable, fraudNetworkEdgesTable, fraudScoresTable } from "@workspace/db";
import { sql, desc } from "drizzle-orm";

const router = Router();

router.get("/network/graph", async (req, res) => {
  try {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const graph = await getNetworkGraph(limit);
    res.json(graph);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch network graph" });
  }
});

router.post("/network/edge", async (req, res) => {
  const { fromWalletId, toWalletId, amount, currency } = req.body;
  if (!fromWalletId || !toWalletId || !amount) {
    return res.status(400).json({ error: "fromWalletId, toWalletId, amount required" });
  }
  try {
    await recordNetworkEdge(fromWalletId, toWalletId, Number(amount), currency);
    res.status(201).json({ recorded: true, fromWalletId, toWalletId });
  } catch (err) {
    res.status(500).json({ error: "Failed to record network edge" });
  }
});

router.get("/scores", async (_req, res) => {
  try {
    const scores = await getTopRiskWallets(20);
    res.json({ scores, count: scores.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch fraud scores" });
  }
});

router.post("/scores/compute", async (req, res) => {
  const { walletId } = req.body;
  if (!walletId) return res.status(400).json({ error: "walletId required" });
  try {
    const result = await computeFraudScore(walletId);
    res.json({ walletId, ...result });
  } catch (err) {
    res.status(500).json({ error: "Failed to compute fraud score" });
  }
});

router.post("/anomaly/detect", async (req, res) => {
  const { walletId } = req.body;
  if (!walletId) return res.status(400).json({ error: "walletId required" });
  try {
    const result = await detectBehavioralAnomalies(walletId);
    res.json({ walletId, ...result });
  } catch (err) {
    res.status(500).json({ error: "Failed to detect anomalies" });
  }
});

router.post("/velocity/cross-wallet", async (req, res) => {
  const { walletIds } = req.body;
  if (!Array.isArray(walletIds) || walletIds.length === 0) {
    return res.status(400).json({ error: "walletIds array required" });
  }
  try {
    const result = await detectCrossWalletVelocity(walletIds);
    res.json({ walletCount: walletIds.length, ...result });
  } catch (err) {
    res.status(500).json({ error: "Failed to run cross-wallet velocity check" });
  }
});

router.get("/stats", async (_req, res) => {
  try {
    const [nodeCount, edgeCount, scoreCount] = await Promise.all([
      db.select({ cnt: sql<number>`count(*)` }).from(fraudNetworkNodesTable),
      db.select({ cnt: sql<number>`count(*)` }).from(fraudNetworkEdgesTable),
      db.select({ cnt: sql<number>`count(*)` }).from(fraudScoresTable),
    ]);
    const topScores = await db.select().from(fraudScoresTable).orderBy(desc(fraudScoresTable.score)).limit(5);
    res.json({
      networkNodes:   Number(nodeCount[0]?.cnt ?? 0),
      networkEdges:   Number(edgeCount[0]?.cnt ?? 0),
      scoresComputed: Number(scoreCount[0]?.cnt ?? 0),
      topHighRisk:    topScores,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch fraud intel stats" });
  }
});

export default router;
