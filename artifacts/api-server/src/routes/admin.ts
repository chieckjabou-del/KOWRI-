import { Router } from "express";
import { reconcileAllWallets, syncWalletBalance } from "../lib/walletService";
import { patchTontineMembers } from "../lib/seed";
import { audit } from "../lib/auditLogger";
import { generateId } from "../lib/id";
import {
  getAllSwitches,
  getSwitch,
  fire,
  forceOff,
  manualLift,
  autoRecover,
  type KillSwitchName,
} from "../lib/killSwitch";
import { rollback } from "../lib/actionExecutor";

const router = Router();

// ── Reconciliation ────────────────────────────────────────────────────────────

router.get("/reconcile", async (req, res, next) => {
  try {
    const fix = req.query.fix === "true";
    const runId = generateId();

    const report = await reconcileAllWallets();
    const mismatchesBefore = report.filter((r) => r.mismatch);
    const fixes: string[] = [];

    if (fix && mismatchesBefore.length > 0) {
      for (const m of mismatchesBefore) {
        await syncWalletBalance(m.walletId);
        fixes.push(m.walletId);
        await audit({
          action: "reconciliation.fixed",
          entity: "wallet",
          entityId: m.walletId,
          metadata: { stored: m.stored, derived: m.derived, runId },
        });
      }
    }

    const reportAfter = fix ? await reconcileAllWallets() : report;
    const mismatchesAfter = reportAfter.filter((r) => r.mismatch);

    await audit({
      action: "reconciliation.run",
      entity: "system",
      entityId: runId,
      metadata: {
        fix,
        totalWallets: report.length,
        mismatchesBefore: mismatchesBefore.length,
        fixed: fixes.length,
        mismatchesAfter: mismatchesAfter.length,
      },
    });

    res.json({
      summary: {
        totalWallets: report.length,
        mismatchesBefore: mismatchesBefore.length,
        fixed: fixes.length,
        mismatchesAfter: mismatchesAfter.length,
        balanced: mismatchesAfter.length === 0,
      },
      mismatches: (fix ? mismatchesAfter : mismatchesBefore).map((m) => ({
        walletId: m.walletId,
        storedBalance: m.stored,
        derivedFromLedger: m.derived,
        drift: Number((m.stored - m.derived).toFixed(4)),
      })),
      allWallets: reportAfter.map((r) => ({
        walletId: r.walletId,
        storedBalance: r.stored,
        derivedFromLedger: r.derived,
        status: r.mismatch ? "MISMATCH" : "OK",
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/patch-tontines", async (req, res, next) => {
  try {
    const result = await patchTontineMembers();
    await audit({
      action: "admin.patch_tontines",
      entity: "system",
      entityId: "tontines",
      metadata: result,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Kill Switches ─────────────────────────────────────────────────────────────
//
// GET    /admin/kill-switches              — list all switches
// GET    /admin/kill-switches/:name        — get one switch
// POST   /admin/kill-switches/:name/fire   — operator-initiated fire
// POST   /admin/kill-switches/:name/force  — lock to FORCED_OFF
// POST   /admin/kill-switches/:name/lift   — manual lift (clears any state)
// POST   /admin/kill-switches/:name/recover — auto-recover (TRIGGERED only)
// POST   /admin/kill-switches/:name/rollback — fire rollback + lift

router.get("/kill-switches", (_req, res) => {
  res.json({ switches: getAllSwitches() });
});

router.get("/kill-switches/:name", (req, res) => {
  const name = req.params.name as KillSwitchName;
  try {
    res.json(getSwitch(name));
  } catch {
    res.status(404).json({ error: "Unknown switch", name });
  }
});

router.post("/kill-switches/:name/fire", (req, res) => {
  const name     = req.params.name as KillSwitchName;
  const operator = (req.body?.operator as string) ?? "admin";
  const reason   = (req.body?.reason   as string) ?? "manual fire";

  fire(name, reason, operator);
  res.json({ switch: name, state: getSwitch(name).state, action: "fired", by: operator });
});

router.post("/kill-switches/:name/force", (req, res) => {
  const name     = req.params.name as KillSwitchName;
  const operator = (req.body?.operator as string) ?? "admin";
  const reason   = (req.body?.reason   as string) ?? "manual force-off";

  forceOff(name, operator, reason);
  res.json({ switch: name, state: getSwitch(name).state, action: "forced_off", by: operator });
});

router.post("/kill-switches/:name/lift", (req, res) => {
  const name     = req.params.name as KillSwitchName;
  const operator = (req.body?.operator as string) ?? "admin";

  manualLift(name, operator);
  res.json({ switch: name, state: getSwitch(name).state, action: "lifted", by: operator });
});

router.post("/kill-switches/:name/recover", (req, res) => {
  const name = req.params.name as KillSwitchName;

  const sw = getSwitch(name);
  if (sw.state === "FORCED_OFF") {
    return res.status(409).json({
      error: "Switch is FORCED_OFF — use /lift to clear it",
      switch: name,
      state: sw.state,
    });
  }

  autoRecover(name);
  return res.json({ switch: name, state: getSwitch(name).state, action: "recovered" });
});

router.post("/kill-switches/:name/rollback", (req, res) => {
  const name     = req.params.name as KillSwitchName;
  const operator = (req.body?.operator as string) ?? "admin";

  const result = rollback(name, operator);
  res.json({ ...result, switch: name, currentState: getSwitch(name).state });
});

export default router;
