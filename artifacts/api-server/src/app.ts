import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";
import { seedDatabase, patchTontineMembers } from "./lib/seed";
import { seedFeeConfig } from "./lib/feeEngine";
import { seedExchangeRates } from "./lib/fxEngine";
import { bootstrapAdminFromEnv } from "./lib/adminAuth";
import { checkSecretsAtBoot } from "./lib/secretsCheck";
import { globalSanitizer, validatePagination } from "./middleware/validate";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { requireAdmin } from "./middleware/auth";
import { seedTreasuryFloat } from "./lib/treasury";
import { stickyPrimaryRequest, stickyPrimaryResponse } from "./middleware/stickyPrimary";
import { paymentRouter } from "./lib/paymentRouter";
import { seedConnectors } from "./lib/connectors";
import { corsOptions, securityHeaders } from "./middleware/security";
import "./services/index";

const app: Express = express();

// Behind Railway/Vercel-style proxies: trust the first hop so req.ip and the
// login rate limiter see the client address, not the proxy.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(securityHeaders);
app.use(cors(corsOptions()));
// KYC submissions carry base64 documents, hence a limit well above the JSON
// default (100 kb) but bounded so a client cannot exhaust memory.
const bodyLimit = process.env.JSON_BODY_LIMIT ?? "2mb";
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

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

// Reveals filesystem layout: operators only.
app.get("/api/debug-build", requireAdmin, async (req, res) => {
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

app.use("/api", router);

app.use(notFoundHandler);
app.use(errorHandler);

seedDatabase()
  .then(() => patchTontineMembers())
  .then((result) => { if (result.patched) console.log("✅ Tontine patch applied:", result.message); })
  .then(() => paymentRouter.seedDefaultRoutes())
  .then(() => seedConnectors())
  .then(() => seedFeeConfig())
  .then(() => seedExchangeRates())
  .then(() => seedTreasuryFloat())
  .then(() => bootstrapAdminFromEnv())
  .then(() => checkSecretsAtBoot())
  .catch((err) => console.error("Seed/patch error:", err));

export default app;
