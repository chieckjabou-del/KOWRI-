import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";
import { seedDatabase, patchTontineMembers } from "./lib/seed";
import { seedFeeConfig } from "./lib/feeEngine";
import { globalSanitizer, validatePagination } from "./middleware/validate";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { stickyPrimaryRequest, stickyPrimaryResponse } from "./middleware/stickyPrimary";
import { apiRateLimit } from "./middleware/apiRateLimit";
import { paymentRouter } from "./lib/paymentRouter";
import { seedConnectors } from "./lib/connectors";
import "./services/index";

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(globalSanitizer);
app.use(validatePagination);
app.use(stickyPrimaryRequest);
app.use(stickyPrimaryResponse);

app.get("/health", (_req, res) => {
  return res.json({ service: "kowri-backend", status: "running" });
});

app.get("/api/health", (_req, res) => {
  return res.json({ service: "kowri-backend", status: "running" });
});

app.get("/api/debug-build", async (req, res) => {
  const fs   = await import("fs");
  const path = await import("path");
  const cwd  = process.cwd();
  // Server runs as: node artifacts/api-server/dist/index.cjs from workspace root
  const appDist  = path.join(cwd, "artifacts/kowri-app/dist/public/index.html");
  const dashDist = path.join(cwd, "artifacts/kowri-dashboard/dist/public/index.html");
  const apiDist  = path.join(cwd, "artifacts/api-server/dist/index.cjs");
  let rootContents: string[] = [];
  let distContents: string[] = [];
  try { rootContents = fs.readdirSync(path.join(cwd, "artifacts")); } catch { rootContents = []; }
  try { distContents = fs.readdirSync(path.join(cwd, "artifacts/kowri-app/dist")).map(String); } catch { distContents = ["<dir missing>"]; }
  res.json({
    cwd,
    appExists:     fs.existsSync(appDist),
    dashExists:    fs.existsSync(dashDist),
    apiDistExists: fs.existsSync(apiDist),
    appPath:       appDist,
    dashPath:      dashDist,
    artifacts:     rootContents,
    kowriAppDist:  distContents,
  });
});

app.use("/api", apiRateLimit);
app.use("/api", router);

app.use(notFoundHandler);
app.use(errorHandler);

seedDatabase()
  .then(() => patchTontineMembers())
  .then((result) => { if (result.patched) console.log("✅ Tontine patch applied:", result.message); })
  .then(() => paymentRouter.seedDefaultRoutes())
  .then(() => seedConnectors())
  .then(() => seedFeeConfig())
  .catch((err) => console.error("Seed/patch error:", err));

export default app;
