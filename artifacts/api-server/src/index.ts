import app from "./app";
import { startOutboxWorker }                             from "./lib/outboxWorker";
import { initKillSwitches }                              from "./lib/killSwitch";
import { startAutopilot }                                from "./lib/autopilot";
import { seedLedgerBalanceSummary, installLedgerTrigger } from "./lib/ledgerBalanceSeeder";
import { rehydrateAutopilotState }                        from "./lib/autopilotStateStore";
import { reconcileAllWallets }                            from "./lib/walletService";
import { logIncident }                                    from "./lib/incidentStore";
import { getPendingJobs, runContributionCycle, runPayoutCycle, distributeToTargets, runHybridCycle, recoverStuckPayouts } from "./lib/tontineScheduler";
import { runDailyReconciliation, runMonthlyAchievements } from "./lib/liquidityEngine";
import { db }                                             from "@workspace/db";
import { tontinePositionListingsTable, schedulerJobsTable } from "@workspace/db";
import { eq, and, lt, isNotNull }                         from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

function startAgentScheduler() {
  // ── Daily reconciliation at 20:00 ─────────────────────────────────────────
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 20 && now.getMinutes() < 1) {
      try {
        await runDailyReconciliation();
      } catch (err: any) {
        logIncident({ type: "agent_scheduler", action: "daily_recon", result: err?.message ?? "unknown" });
      }
    }
  }, 60_000); // poll every minute

  // ── Monthly achievement check — first day of each month at 08:00 ──────────
  setInterval(async () => {
    const now = new Date();
    if (now.getDate() === 1 && now.getHours() === 8 && now.getMinutes() < 1) {
      try {
        await runMonthlyAchievements();
      } catch (err: any) {
        logIncident({ type: "agent_scheduler", action: "monthly_achievements", result: err?.message ?? "unknown" });
      }
    }
  }, 60_000);
}

function startTontineScheduler() {
  setInterval(async () => {
    try {
      // ── 1. Expire stale position listings ─────────────────────────────────
      await db.update(tontinePositionListingsTable)
        .set({ status: "expired" })
        .where(
          and(
            eq(tontinePositionListingsTable.status, "open"),
            isNotNull(tontinePositionListingsTable.expiresAt),
            lt(tontinePositionListingsTable.expiresAt!, new Date()),
          ),
        );

      // ── 2. Execute pending tontine scheduler jobs ──────────────────────────
      const jobs = await getPendingJobs();
      for (const job of jobs) {
        if (job.scheduledAt > new Date()) continue;

        // Claim job (optimistic lock) — prevents duplicate execution
        const claimed = await db.update(schedulerJobsTable)
          .set({ status: "running", runAt: new Date(), attempts: job.attempts + 1 })
          .where(and(eq(schedulerJobsTable.id, job.id), eq(schedulerJobsTable.status, "pending")))
          .returning({ id: schedulerJobsTable.id });
        if (!claimed.length) continue;

        try {
          if (job.jobType === "tontine_contribution") {
            await runContributionCycle(job.entityId);
          } else if (job.jobType === "tontine_payout") {
            await runPayoutCycle(job.entityId);
          } else if (job.jobType === "tontine_strategy_distribute") {
            await distributeToTargets(job.entityId);
          } else if (job.jobType === "tontine_hybrid_rebalance") {
            await runHybridCycle(job.entityId);
          }
          await db.update(schedulerJobsTable)
            .set({ status: "completed" })
            .where(eq(schedulerJobsTable.id, job.id));
        } catch (jobErr: any) {
          const nextAttempts = job.attempts + 1;
          await db.update(schedulerJobsTable)
            .set({
              status: nextAttempts >= job.maxAttempts ? "failed" : "pending",
              error: jobErr?.message ?? "unknown",
            })
            .where(eq(schedulerJobsTable.id, job.id));
          logIncident({
            type: "tontine_scheduler",
            action: "cycle_error",
            result: jobErr?.message ?? "unknown",
          });
        }
      }
    } catch (err: any) {
      logIncident({
        type: "tontine_scheduler",
        action: "cycle_error",
        result: err?.message ?? "unknown",
      });
    }
  }, 60_000); // every 60 seconds
}

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  startOutboxWorker();
  startTontineScheduler();
  startAgentScheduler();
  // Hydrate kill switch cache from DB before starting autopilot so the first
  // cycle sees operator-set state rather than the in-memory defaults.
  initKillSwitches()
    .then(() => installLedgerTrigger())
    .then(() => seedLedgerBalanceSummary())
    .then(() => rehydrateAutopilotState())
    .then(() => recoverStuckPayouts().catch((err) =>
      console.error("[Startup] recoverStuckPayouts failed (non-fatal):", err),
    ))
    .then(() => startAutopilot())
    .then(() => {
      setInterval(async () => {
        try {
          const result = await reconcileAllWallets();
          if (result.mismatches.length > 0) {
            logIncident({
              type: "reconciliation",
              action: "scheduled_run",
              result: `${result.mismatches.length} mismatches found`,
            });
          }
        } catch (err: any) {
          logIncident({
            type: "reconciliation",
            action: "scheduled_run",
            result: `error: ${err?.message}`,
          });
        }
      }, 6 * 60 * 60 * 1000); // every 6 hours
    })
    .catch((err) => {
      console.error("[Startup] init failed:", err);
      // Start autopilot anyway — metricsCollector falls back to 0 for balance_drift.
      startAutopilot();
    });
});
