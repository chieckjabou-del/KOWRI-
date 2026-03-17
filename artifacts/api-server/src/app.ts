import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";
import { seedDatabase, patchTontineMembers } from "./lib/seed";
import { globalSanitizer, validatePagination } from "./middleware/validate";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { stickyPrimaryRequest, stickyPrimaryResponse } from "./middleware/stickyPrimary";
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

app.get("/health", (req, res) => {
  res.json({ service: "kowri-backend", status: "running" });
});

app.use("/api", router);

app.use(notFoundHandler);
app.use(errorHandler);

seedDatabase()
  .then(() => patchTontineMembers())
  .then((result) => { if (result.patched) console.log("✅ Tontine patch applied:", result.message); })
  .then(() => paymentRouter.seedDefaultRoutes())
  .then(() => seedConnectors())
  .catch((err) => console.error("Seed/patch error:", err));

export default app;
