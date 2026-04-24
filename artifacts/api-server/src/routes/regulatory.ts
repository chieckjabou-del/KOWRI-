import { Router } from "express";
import { generateReport, listReports, getReportEntries } from "../lib/regulatoryReporting";
import type { ReportType, ReportFormat } from "../lib/regulatoryReporting";

const router = Router();

const VALID_TYPES: ReportType[]   = ["suspicious_activity", "high_value_transactions", "daily_transaction_summary"];
const VALID_FORMATS: ReportFormat[] = ["json"];

router.get("/reports", async (_req, res) => {
  try {
    const reports = await listReports();
    return res.json({ reports, count: reports.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to list reports" });
  }
});

router.post("/reports/generate", async (req, res) => {
  const { reportType, format = "json", periodStart, periodEnd } = req.body;
  if (!reportType || !VALID_TYPES.includes(reportType)) {
    return res.status(400).json({ error: `reportType must be one of: ${VALID_TYPES.join(", ")}` });
  }
  if (!VALID_FORMATS.includes(format)) {
    return res.status(400).json({ error: `format must be one of: ${VALID_FORMATS.join(", ")}` });
  }
  try {
    const opts = {
      periodStart: periodStart ? new Date(periodStart) : undefined,
      periodEnd:   periodEnd   ? new Date(periodEnd)   : undefined,
    };
    const result = await generateReport(reportType as ReportType, format as ReportFormat, opts);
    return res.status(201).json({
      reportId:    result.reportId,
      reportType:  result.reportType,
      format:      result.format,
      recordCount: result.recordCount,
      data:        result.data,
    });
  } catch (err) {
    return res.status(500).json({ error: "Report generation failed" });
  }
});

router.get("/reports/:reportId", async (req, res) => {
  try {
    const entries = await getReportEntries(req.params.reportId);
    return res.json({ reportId: req.params.reportId, entries, count: entries.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch report entries" });
  }
});

router.get("/reports/:reportId/export", async (req, res) => {
  const { format = "json" } = req.query;
  try {
    if (format !== "json") {
      return res.status(406).json({
        error: true,
        message: "Only JSON export is supported for /api routes",
      });
    }
    const entries = await getReportEntries(req.params.reportId);
    const data    = entries.map(e => e.data as Record<string, unknown>);
    return res.json({ reportId: req.params.reportId, format: "json", data, count: data.length });
  } catch (err) {
    return res.status(500).json({ error: "Export failed" });
  }
});

export default router;
