import { Router } from "express";
import { reconcileAllWallets, syncWalletBalance } from "../lib/walletService";
import { patchTontineMembers } from "../lib/seed";

const router = Router();

router.get("/reconcile", async (req, res, next) => {
  try {
    const fix = req.query.fix === "true";

    const report = await reconcileAllWallets();
    const mismatchesBefore = report.filter((r) => r.mismatch);
    const fixes: string[] = [];

    if (fix && mismatchesBefore.length > 0) {
      for (const m of mismatchesBefore) {
        await syncWalletBalance(m.walletId);
        fixes.push(m.walletId);
      }
    }

    const reportAfter = fix ? await reconcileAllWallets() : report;
    const mismatchesAfter = reportAfter.filter((r) => r.mismatch);

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
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
