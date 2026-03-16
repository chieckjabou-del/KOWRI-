import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import walletsRouter from "./wallets";
import transactionsRouter from "./transactions";
import tontinesRouter from "./tontines";
import creditRouter from "./credit";
import merchantsRouter from "./merchants";
import complianceRouter from "./compliance";
import analyticsRouter from "./analytics";
import adminRouter from "./admin";
import systemRouter from "./system";
import sagasRouter from "./sagas";
import riskRouter from "./risk";
import webhooksRouter from "./webhooks";
import fxRouter from "./fx";
import settlementsRouter from "./settlements";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/users", usersRouter);
router.use("/wallets", walletsRouter);
router.use("/transactions", transactionsRouter);
router.use("/tontines", tontinesRouter);
router.use("/credit", creditRouter);
router.use("/merchants", merchantsRouter);
router.use("/compliance", complianceRouter);
router.use("/analytics", analyticsRouter);
router.use("/admin", adminRouter);
router.use("/system", systemRouter);
router.use("/sagas", sagasRouter);
router.use("/risk", riskRouter);
router.use("/webhooks", webhooksRouter);
router.use("/fx", fxRouter);
router.use("/settlements", settlementsRouter);

export default router;
