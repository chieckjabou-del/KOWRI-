import app from "./app";
import { startOutboxWorker, stopOutboxWorker }             from "./lib/outboxWorker";
import { initKillSwitches }                              from "./lib/killSwitch";
import { startAutopilot, stopAutopilot }                  from "./lib/autopilot";
import { seedLedgerBalanceSummary, installLedgerTrigger } from "./lib/ledgerBalanceSeeder";
import { rehydrateAutopilotState }                        from "./lib/autopilotStateStore";
import { reconcileAllWallets }                            from "./lib/walletService";
import { logIncident }                                    from "./lib/incidentStore";
import { getPendingJobs, runContributionCycle, runPayoutCycle, distributeToTargets, runHybridCycle, recoverStuckPayouts } from "./lib/tontineScheduler";
import { runDailyReconciliation, runMonthlyAchievements } from "./lib/liquidityEngine";
import { withInstanceLock }                               from "./lib/instanceLock";
import { db, pool }                                       from "@workspace/db";
import { tontinePositionListingsTable, schedulerJobsTable } from "@workspace/db";
import { eq, and, lt, isNotNull }                         from "drizzle-orm";

// ── Process-level failure policy ─────────────────────────────────────────────
// An uncaught exception means the process state is unknown: log it, then shut
// down cleanly and let the supervisor restart us. A rejected promise nobody
// awaited is logged as an incident but does not take the process down.
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err?.stack ?? err?.message ?? err);
  logIncident({ type: "process", action: "uncaught_exception", result: err?.message ?? "unknown" });
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.error("[FATAL] unhandledRejection:", msg);
  logIncident({ type: "process", action: "unhandled_rejection", result: msg.slice(0, 500) });
});

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

// Every timer is tracked so shutdown can stop them; every timer body takes a
// cross-instance lock so only one API instance runs a given job per tick.
const timers: NodeJS.Timeout[] = [];
function every(ms: number, fn: () => Promise<void> | void): void {
  const t = setInterval(() => { void fn(); }, ms);
  timers.push(t);
}

function startAgentScheduler() {
  // ── Daily reconciliation at 20:00 ─────────────────────────────────────────
  every(60_000, async () => {
    const now = new Date();
    if (now.getHours() === 20 && now.getMinutes() < 1) {
      try {
        await withInstanceLock("agent_daily_reconciliation", () => runDailyReconciliation());
      } catch (err: any) {
        logIncident({ type: "agent_scheduler", action: "daily_recon", result: err?.message ?? "unknown" });
      }
    }
  });

  // ── Monthly achievement check — first day of each month at 08:00 ──────────
  every(60_000, async () => {
    const now = new Date();
    if (now.getDate() === 1 && now.getHours() === 8 && now.getMinutes() < 1) {
      try {
        await withInstanceLock("agent_monthly_achievements", () => runMonthlyAchievements());
      } catch (err: any) {
        logIncident({ type: "agent_scheduler", action: "monthly_achievements", result: err?.message ?? "unknown" });
      }
    }
  });
}

async function tontineSchedulerTick(): Promise<void> {
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
}

function startTontineScheduler() {
  every(60_000, async () => {
    try {
      await withInstanceLock("tontine_scheduler", tontineSchedulerTick);
    } catch (err: any) {
      logIncident({
        type: "tontine_scheduler",
        action: "cycle_error",
        result: err?.message ?? "unknown",
      });
    }
  }); // every 60 seconds
}

const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);

  // Keep-alive self-request for hosts that sleep idle processes; opt-in only.
  if (process.env.SELF_PING === "true") {
    every(4 * 60 * 1000, async () => {
      try { await fetch(`http://localhost:${port}/health`); } catch {}
    });
  }
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
      every(6 * 60 * 60 * 1000, async () => {
        try {
          await withInstanceLock("wallet_reconciliation", async () => {
            const result = await reconcileAllWallets();
            const mismatchCount = result.filter((r) => r.mismatch).length;
            if (mismatchCount > 0) {
              logIncident({
                type: "reconciliation",
                action: "scheduled_run",
                result: `${mismatchCount} mismatches found`,
              });
            }
          });
        } catch (err: any) {
          logIncident({
            type: "reconciliation",
            action: "scheduled_run",
            result: `error: ${err?.message}`,
          });
        }
      }); // every 6 hours
    })
    .catch((err) => {
      console.error("[Startup] init failed:", err);
      // Start autopilot anyway — metricsCollector falls back to 0 for balance_drift.
      startAutopilot();
    });
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// On SIGTERM/SIGINT (deploys, scale-down): stop taking new connections, stop
// the timers and workers, let in-flight requests finish, close the pool, exit.
// A hard deadline guarantees the process never hangs on a stuck connection.
let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadlineMs = Number(process.env.SHUTDOWN_TIMEOUT_S ?? 15) * 1000;
  console.log(`[Shutdown] ${signal} received — draining (deadline ${deadlineMs / 1000}s)`);

  const force = setTimeout(() => {
    console.error("[Shutdown] deadline reached, forcing exit");
    try { server.closeAllConnections(); } catch {}
    process.exit(exitCode || 1);
  }, deadlineMs);
  force.unref();

  for (const t of timers) clearInterval(t);
  try { stopOutboxWorker(); } catch (err) { console.error("[Shutdown] outbox worker:", err); }
  try { stopAutopilot(); } catch (err) { console.error("[Shutdown] autopilot:", err); }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    try { server.closeIdleConnections(); } catch {}
  });
  try { await pool.end(); } catch (err) { console.error("[Shutdown] pool:", err); }
  console.log("[Shutdown] complete");
  clearTimeout(force);
  process.exit(exitCode);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT"); });
