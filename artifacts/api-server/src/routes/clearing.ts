import { Router } from "express";
import {
  createClearingBatch,
  addClearingEntry,
  submitBatch,
  settleBatch,
  failBatch,
  getBatches,
  getBatchEntries,
  getClearingStats,
} from "../lib/clearingEngine";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const { institution } = _req.query;
    const batches = await getBatches(institution as string | undefined);
    res.json({ batches, count: batches.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch clearing batches" });
  }
});

router.post("/batches", async (req, res) => {
  const { institutionId, currency, metadata } = req.body;
  if (!institutionId) return res.status(400).json({ error: "institutionId required" });
  try {
    const batch = await createClearingBatch(institutionId, currency, metadata);
    res.status(201).json(batch);
  } catch (err) {
    res.status(500).json({ error: "Failed to create clearing batch" });
  }
});

router.post("/batches/:batchId/entries", async (req, res) => {
  const { batchId } = req.params;
  const { fromAccountId, toAccountId, amount, currency, externalRef, metadata } = req.body;
  if (!fromAccountId || !toAccountId || !amount) {
    return res.status(400).json({ error: "fromAccountId, toAccountId, amount required" });
  }
  try {
    const entryId = await addClearingEntry(batchId, { fromAccountId, toAccountId, amount: Number(amount), currency, externalRef, metadata });
    res.status(201).json({ entryId, batchId });
  } catch (err) {
    res.status(500).json({ error: "Failed to add clearing entry" });
  }
});

router.get("/batches/:batchId/entries", async (req, res) => {
  try {
    const entries = await getBatchEntries(req.params.batchId);
    res.json({ entries, count: entries.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch entries" });
  }
});

router.post("/batches/:batchId/submit", async (req, res) => {
  try {
    await submitBatch(req.params.batchId);
    res.json({ submitted: true, batchId: req.params.batchId, status: "submitted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to submit batch" });
  }
});

router.post("/batches/:batchId/settle", async (req, res) => {
  try {
    await settleBatch(req.params.batchId);
    res.json({ settled: true, batchId: req.params.batchId, status: "settled" });
  } catch (err) {
    res.status(500).json({ error: "Failed to settle batch" });
  }
});

router.post("/batches/:batchId/fail", async (req, res) => {
  const { reason } = req.body;
  try {
    await failBatch(req.params.batchId, reason ?? "Manual failure");
    res.json({ failed: true, batchId: req.params.batchId, status: "failed" });
  } catch (err) {
    res.status(500).json({ error: "Failed to mark batch failed" });
  }
});

router.get("/stats", async (_req, res) => {
  try {
    const stats = await getClearingStats();
    res.json({ stats, statuses: ["pending", "submitted", "clearing", "settled", "failed"] });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch clearing stats" });
  }
});

export default router;
