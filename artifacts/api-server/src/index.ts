import app from "./app";
import { startOutboxWorker }                             from "./lib/outboxWorker";
import { initKillSwitches }                              from "./lib/killSwitch";
import { startAutopilot }                                from "./lib/autopilot";
import { seedLedgerBalanceSummary, installLedgerTrigger } from "./lib/ledgerBalanceSeeder";
import { rehydrateAutopilotState }                        from "./lib/autopilotStateStore";
import { reconcileAllWallets }                            from "./lib/walletService";
import { logIncident }                                    from "./lib/incidentStore";

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

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  startOutboxWorker();
  // Hydrate kill switch cache from DB before starting autopilot so the first
  // cycle sees operator-set state rather than the in-memory defaults.
  initKillSwitches()
    .then(() => installLedgerTrigger())
    .then(() => seedLedgerBalanceSummary())
    .then(() => rehydrateAutopilotState())
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
