import { Router } from "express";
import { archiveLedger, getArchiveStats, queryArchive } from "../lib/archiver";

const router = Router();

router.get("/stats", async (_req, res) => {
  try {
    const stats = await getArchiveStats();
    return res.json({ archives: stats, totalYears: stats.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch archive stats" });
  }
});

router.get("/query", async (req, res) => {
  try {
    const walletId = req.query.walletId as string;
    const year     = req.query.year ? Number(req.query.year) : undefined;
    if (!walletId) return res.status(400).json({ error: "walletId is required" });
    const entries = await queryArchive(walletId, year);
    return res.json({ entries, total: entries.length, walletId, year });
  } catch (err) {
    return res.status(500).json({ error: "Failed to query archive" });
  }
});

router.post("/run", async (req, res) => {
  try {
    const beforeYear = Number(req.body.beforeYear);
    const batchSize  = req.body.batchSize ? Number(req.body.batchSize) : undefined;
    if (!beforeYear || beforeYear < 2020 || beforeYear > 2030) {
      return res.status(400).json({ error: "beforeYear must be between 2020 and 2030" });
    }
    const result = await archiveLedger(beforeYear, batchSize);
    return res.json({ ...result, message: `Archived ${result.archivedCount} transactions` });
  } catch (err) {
    return res.status(500).json({ error: "Archive failed" });
  }
});

export default router;
