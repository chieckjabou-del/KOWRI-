import app from "./app";
import { startOutboxWorker } from "./lib/outboxWorker";
import { initKillSwitches } from "./lib/killSwitch";

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
  initKillSwitches().catch((err) =>
    console.error("[KillSwitch] init failed:", err),
  );
});
