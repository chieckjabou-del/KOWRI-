import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAdmin, requireOperatorSession, resolveAdmin } from "../middleware/auth";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";
import { routeParamString } from "../lib/routeParams";
import { cashInLimits, initiateCashIn, approveCashIn, rejectCashIn, cancelCashIn, getCashIn, listCashIn, expireCashInRequests, CashInError } from "../lib/cashIn";
import { CASH_IN_STATUSES, CASH_IN_SOURCES } from "@workspace/db";

// Money creation (cash-in) under maker-checker control. See lib/cashIn.ts.
const router = Router();

function handle(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof CashInError) {
    res.status(err.status).json({ error: true, code: err.code, message: err.message });
    return;
  }
  // A second execution of the same request races the first on the ledger's
  // unique idempotency key: refused, never re-applied.
  const pg = (((err as any)?.cause && typeof (err as any).cause === "object") ? (err as any).cause : err) as { code?: string; constraint?: string; message?: string };
  if (pg?.code === "23505" && /idempotency|reference/.test(`${pg.constraint ?? ""} ${pg.message ?? ""}`)) {
    res.status(409).json({ error: true, code: "CASH_IN_ALREADY_EXECUTED", message: "This request was already executed" });
    return;
  }
  if (pg?.code === "23000" && typeof pg.message === "string" && pg.message.startsWith("CASH_IN_")) {
    res.status(409).json({ error: true, code: pg.message.split(" ")[0], message: pg.message });
    return;
  }
  next(err);
}

router.get("/limits", requireAdmin, (_req, res) => {
  res.json({ limits: cashInLimits(), referenceCurrency: "XOF", statuses: CASH_IN_STATUSES, sources: CASH_IN_SOURCES });
});

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (status && !(CASH_IN_STATUSES as readonly string[]).includes(status)) return res.status(400).json({ error: true, message: `status must be one of ${CASH_IN_STATUSES.join(", ")}` });
    const requests = await listCashIn({
      status, walletId: typeof req.query.walletId === "string" ? req.query.walletId : undefined,
      initiatedBy: typeof req.query.initiatedBy === "string" ? req.query.initiatedBy : undefined,
      limit: Number(req.query.limit) || undefined,
    });
    return res.json({ requests, total: requests.length });
  } catch (err) { return next(err); }
});

router.post("/", requireOperatorSession("ledger.write"), requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { walletId, amount, currency, reference, source, description } = req.body ?? {};
    const request = await initiateCashIn({ walletId, amount, currency, reference, source, description, initiator: req.admin!, ip: req.ip });
    return res.status(201).json({ request });
  } catch (err) { return handle(err, res, next); }
});

// Runs the expiry sweep now (the scheduler runs it every five minutes).
router.post("/expire", requireOperatorSession("ledger.approve"), async (_req, res, next) => {
  try {
    return res.json({ expired: await expireCashInRequests() });
  } catch (err) { return handle(err, res, next); }
});

router.get("/:id", requireAdmin, async (req, res, next) => {
  try {
    const request = await getCashIn(routeParamString(req, "id")!);
    if (!request) return res.status(404).json({ error: true, code: "CASH_IN_NOT_FOUND", message: "Cash-in request not found" });
    return res.json({ request });
  } catch (err) { return next(err); }
});

router.post("/:id/approve", requireOperatorSession("ledger.approve"), async (req, res, next) => {
  try {
    const result = await approveCashIn(routeParamString(req, "id")!, req.admin!, { reason: req.body?.reason, ip: req.ip });
    return res.json(result);
  } catch (err) { return handle(err, res, next); }
});

router.post("/:id/reject", requireOperatorSession("ledger.approve"), async (req, res, next) => {
  try {
    const request = await rejectCashIn(routeParamString(req, "id")!, req.admin!, { reason: req.body?.reason, ip: req.ip });
    return res.json({ request });
  } catch (err) { return handle(err, res, next); }
});

// Initiator (own request) or any approver; the permission split is decided in lib/cashIn.ts.
router.post("/:id/cancel", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.status(403).json({ error: "Admin access required" });
    const request = await cancelCashIn(routeParamString(req, "id")!, admin, { reason: req.body?.reason, ip: req.ip });
    return res.json({ request });
  } catch (err) { return handle(err, res, next); }
});

export default router;
