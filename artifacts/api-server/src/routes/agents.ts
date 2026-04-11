// ── Agent Network Routes ──────────────────────────────────────────────────────
// Mount at /api/agents

import { Router }       from "express";
import { db }           from "@workspace/db";
import {
  agentsTable,
  agentWalletsTable,
  liquidityAlertsTable,
  liquidityTransfersTable,
  agentCommissionsTable,
  agentAnomaliesTable,
  cashReconciliationsTable,
  withdrawalApprovalsTable,
  agentAchievementsTable,
  walletsTable,
  usersTable,
}                        from "@workspace/db";
import { eq, and, sql, desc, gte, or } from "drizzle-orm";
import { generateId }    from "../lib/id";
import {
  checkLiquidity,
  computeCommission,
  executeFloatTransfer,
  suggestRebalance,
  updateMonthlyVolume,
  runLiquidityMonitor,
  updateAgentTrustScore,
  createAnomaly,
  createWithdrawalApproval,
  checkLargeWithdrawalApproval,
  submitReconciliation,
  createPendingReconciliation,
  checkAchievements,
}                        from "../lib/liquidityEngine";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function cashStatus(cash: number, min: number): "OK" | "WARNING" | "CRITICAL" {
  if (cash >= min)           return "OK";
  if (cash >= min * 0.5)     return "WARNING";
  return "CRITICAL";
}

// ── GET /agents/zones ─────────────────────────────────────────────────────────
// Must be registered BEFORE /:id to avoid "zones" being treated as an id.
router.get("/zones", async (_req, res, next) => {
  try {
    const agents = await db.select().from(agentsTable).where(eq(agentsTable.status, "ACTIVE"));

    const zoneMap: Record<string, {
      agentCount: number;
      agentIds:   string[];
      zone:       string;
    }> = {};

    for (const a of agents) {
      if (!zoneMap[a.zone]) zoneMap[a.zone] = { agentCount: 0, agentIds: [], zone: a.zone };
      zoneMap[a.zone].agentCount++;
      zoneMap[a.zone].agentIds.push(a.id);
    }

    const zones = await Promise.all(
      Object.values(zoneMap).map(async (z) => {
        const [wallets, alertsResult] = await Promise.all([
          db.select({
            totalFloat: sql<number>`COALESCE(SUM(CAST(float_balance AS NUMERIC)), 0)`,
            totalCash:  sql<number>`COALESCE(SUM(CAST(cash_balance  AS NUMERIC)), 0)`,
          })
          .from(agentWalletsTable)
          .where(sql`agent_id = ANY(ARRAY[${sql.raw(z.agentIds.map(id => `'${id}'`).join(","))}]::text[])`),
          db.select({ count: sql<number>`COUNT(*)::int`, level: liquidityAlertsTable.level })
            .from(liquidityAlertsTable)
            .where(
              and(
                sql`agent_id = ANY(ARRAY[${sql.raw(z.agentIds.map(id => `'${id}'`).join(","))}]::text[])`,
                eq(liquidityAlertsTable.resolved, false),
              ),
            )
            .groupBy(liquidityAlertsTable.level),
        ]);

        const totalFloat  = Number(wallets[0]?.totalFloat ?? 0);
        const totalCash   = Number(wallets[0]?.totalCash  ?? 0);
        const alertCount  = alertsResult.reduce((s, r) => s + Number(r.count), 0);
        const critCount   = alertsResult.find(r => r.level === "CRITICAL")?.count ?? 0;

        const tensionLevel: "LOW" | "MEDIUM" | "HIGH" =
          Number(critCount) > 0                       ? "HIGH"   :
          alertCount >= z.agentCount * 0.5            ? "MEDIUM" :
          "LOW";

        return { zone: z.zone, agentCount: z.agentCount, totalFloat, totalCash, alertCount, tensionLevel };
      }),
    );

    return res.json({ zones });
  } catch (err) { return next(err); }
});

// ── POST /agents ───────────────────────────────────────────────────────────────
// Register a new agent + auto-create linked KOWRI wallet + agent_wallet row.
router.post("/", async (req, res, next) => {
  try {
    const { userId, name, type, phone, zone, parentAgentId } = req.body as {
      userId: string; name: string; type: "AGENT" | "SUPER_AGENT" | "MASTER";
      phone: string; zone: string; parentAgentId?: string;
    };

    if (!name || !type || !phone || !zone) {
      return res.status(400).json({ error: "name, type, phone, zone are required" });
    }
    if (!["AGENT", "SUPER_AGENT", "MASTER"].includes(type)) {
      return res.status(400).json({ error: "Invalid type" });
    }

    // Validate userId exists in users table (wallet FK requires this)
    if (userId) {
      const user = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      if (user.length === 0) return res.status(400).json({ error: "userId not found in users table" });
    }

    const agentId  = generateId();
    const walletId = generateId();

    // Default thresholds by type
    const minCash  = type === "AGENT" ? "100000"  : "1000000";
    const minFloat = type === "AGENT" ? "100000"  : "1000000";
    const maxCash  = type === "AGENT" ? "2000000" : "10000000";

    // Create linked KOWRI wallet (merchant type)
    await db.insert(walletsTable).values({
      id:               walletId,
      userId:           userId ?? agentId,
      currency:         "XOF",
      walletType:       "merchant",
      balance:          "0",
      availableBalance: "0",
      status:           "active",
    });

    // Create agent record
    await db.insert(agentsTable).values({
      id:            agentId,
      userId:        userId ?? null,
      name,
      type,
      phone,
      zone,
      status:        "ACTIVE",
      parentAgentId: parentAgentId ?? null,
      monthlyVolume: "0",
      commissionTier: 1,
    });

    // Create agent wallet
    await db.insert(agentWalletsTable).values({
      id:               generateId(),
      agentId,
      walletId,
      cashBalance:      "0",
      floatBalance:     "0",
      minCashThreshold:  minCash,
      minFloatThreshold: minFloat,
      maxCashBalance:    maxCash,
    });

    const agent  = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1).then(r => r[0]);
    const wallet = await db.select().from(agentWalletsTable).where(eq(agentWalletsTable.agentId, agentId)).limit(1).then(r => r[0]);

    return res.status(201).json({ agent, wallet, walletId });
  } catch (err) { return next(err); }
});

// ── GET /agents ────────────────────────────────────────────────────────────────
// List agents with optional filters and liquidity summary.
router.get("/", async (req, res, next) => {
  try {
    const { zone, type, status, userId, limit: lim, offset: off } = req.query as Record<string, string>;
    const limit  = Math.min(Number(lim) || 50, 200);
    const offset = Number(off) || 0;

    let query = db.select().from(agentsTable) as any;
    const conditions: any[] = [];

    if (zone)   conditions.push(eq(agentsTable.zone,   zone));
    if (type)   conditions.push(eq(agentsTable.type,   type as any));
    if (status) conditions.push(eq(agentsTable.status, status as any));
    if (userId) conditions.push(eq(agentsTable.userId, userId));

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const agents = await query.limit(limit).offset(offset).orderBy(desc(agentsTable.createdAt));

    // Attach liquidity summary
    const enriched = await Promise.all(
      agents.map(async (a: any) => {
        const w = await db.select().from(agentWalletsTable).where(eq(agentWalletsTable.agentId, a.id)).limit(1).then(r => r[0] ?? null);
        const alertCount = await db.select({ count: sql<number>`COUNT(*)::int` })
          .from(liquidityAlertsTable)
          .where(and(eq(liquidityAlertsTable.agentId, a.id), eq(liquidityAlertsTable.resolved, false)))
          .then(r => Number(r[0]?.count ?? 0));
        return {
          ...a,
          liquidity: {
            cashBalance:  Number(w?.cashBalance  ?? 0),
            floatBalance: Number(w?.floatBalance ?? 0),
            cashStatus:   cashStatus(Number(w?.cashBalance ?? 0),  Number(w?.minCashThreshold  ?? 0)),
            floatStatus:  cashStatus(Number(w?.floatBalance ?? 0), Number(w?.minFloatThreshold ?? 0)),
            activeAlerts: alertCount,
          },
        };
      }),
    );

    return res.json({ agents: enriched, count: enriched.length, limit, offset });
  } catch (err) { return next(err); }
});

// ── GET /agents/:id ─────────────────────────────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const agent = await db.select().from(agentsTable).where(eq(agentsTable.id, req.params.id)).limit(1).then(r => r[0] ?? null);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const [wallet, alerts] = await Promise.all([
      db.select().from(agentWalletsTable).where(eq(agentWalletsTable.agentId, agent.id)).limit(1).then(r => r[0] ?? null),
      db.select().from(liquidityAlertsTable)
        .where(and(eq(liquidityAlertsTable.agentId, agent.id), eq(liquidityAlertsTable.resolved, false)))
        .orderBy(desc(liquidityAlertsTable.createdAt))
        .limit(10),
    ]);

    return res.json({ agent, wallet, activeAlerts: alerts });
  } catch (err) { return next(err); }
});

// ── GET /agents/:id/liquidity ─────────────────────────────────────────────────
router.get("/:id/liquidity", async (req, res, next) => {
  try {
    const agentId = req.params.id;
    const agent   = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1).then(r => r[0] ?? null);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const [wallet, liquidity, alerts, rebalance] = await Promise.all([
      db.select().from(agentWalletsTable).where(eq(agentWalletsTable.agentId, agentId)).limit(1).then(r => r[0] ?? null),
      checkLiquidity(agentId),
      db.select().from(liquidityAlertsTable)
        .where(and(eq(liquidityAlertsTable.agentId, agentId), eq(liquidityAlertsTable.resolved, false)))
        .orderBy(desc(liquidityAlertsTable.level), desc(liquidityAlertsTable.createdAt)),
      suggestRebalance(agentId),
    ]);

    // Nearest Super Agent info
    let nearestSuperAgent = null;
    if (rebalance.suggestedFromAgent) {
      const sa = await db.select().from(agentsTable).where(eq(agentsTable.id, rebalance.suggestedFromAgent)).limit(1).then(r => r[0] ?? null);
      const saWallet = sa ? await db.select().from(agentWalletsTable).where(eq(agentWalletsTable.agentId, sa.id)).limit(1).then(r => r[0] ?? null) : null;
      if (sa) {
        nearestSuperAgent = {
          id:           sa.id,
          name:         sa.name,
          zone:         sa.zone,
          floatBalance: Number(saWallet?.floatBalance ?? 0),
        };
      }
    }

    return res.json({
      cashBalance:      liquidity.cashBalance,
      floatBalance:     liquidity.floatBalance,
      cashStatus:       cashStatus(liquidity.cashBalance,  Number(wallet?.minCashThreshold  ?? 0)),
      floatStatus:      cashStatus(liquidity.floatBalance, Number(wallet?.minFloatThreshold ?? 0)),
      minCashThreshold: Number(wallet?.minCashThreshold  ?? 0),
      minFloatThreshold:Number(wallet?.minFloatThreshold ?? 0),
      maxCashBalance:   Number(wallet?.maxCashBalance    ?? 0),
      monthlyVolume:    Number(agent.monthlyVolume  ?? 0),
      commissionTier:   agent.commissionTier ?? 1,
      trustScore:       agent.trustScore     ?? 100,
      trustLevel:       agent.trustLevel     ?? "TRUSTED",
      anomalyCount:     agent.anomalyCount   ?? 0,
      activeAlerts:     alerts,
      suggestions:      liquidity.suggestions,
      nearestSuperAgent,
      rebalanceSuggestion: rebalance,
    });
  } catch (err) { return next(err); }
});

// ── GET /agents/:id/alerts ────────────────────────────────────────────────────
router.get("/:id/alerts", async (req, res, next) => {
  try {
    const alerts = await db.select()
      .from(liquidityAlertsTable)
      .where(and(eq(liquidityAlertsTable.agentId, req.params.id), eq(liquidityAlertsTable.resolved, false)))
      .orderBy(desc(liquidityAlertsTable.level), desc(liquidityAlertsTable.createdAt));
    return res.json({ alerts, count: alerts.length });
  } catch (err) { return next(err); }
});

// ── PATCH /agents/:id/alerts/:alertId/resolve ─────────────────────────────────
router.patch("/:id/alerts/:alertId/resolve", async (req, res, next) => {
  try {
    await db.update(liquidityAlertsTable)
      .set({ resolved: true, resolvedAt: new Date() })
      .where(and(eq(liquidityAlertsTable.id, req.params.alertId), eq(liquidityAlertsTable.agentId, req.params.id)));
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ── POST /agents/:id/liquidity-transfer ───────────────────────────────────────
router.post("/:id/liquidity-transfer", async (req, res, next) => {
  try {
    const idempKey = req.headers["idempotency-key"] as string;
    if (!idempKey) return res.status(400).json({ error: "Idempotency-Key header required" });

    const { toAgentId, amount, type: txType } = req.body as {
      toAgentId: string; amount: number; type: "FLOAT" | "CASH";
    };

    if (!toAgentId || !amount || amount <= 0) {
      return res.status(400).json({ error: "toAgentId and amount > 0 required" });
    }

    // Idempotency check
    const existing = await db.select()
      .from(liquidityTransfersTable)
      .where(eq(liquidityTransfersTable.note, `idempkey:${idempKey}`))
      .limit(1);
    if (existing.length > 0) return res.json({ transfer: existing[0], idempotent: true });

    if (txType === "FLOAT") {
      await executeFloatTransfer(req.params.id, toAgentId, amount);
    } else {
      // CASH transfers are manually recorded (physical handoff)
      await db.insert(liquidityTransfersTable).values({
        id:          generateId(),
        fromAgentId: req.params.id,
        toAgentId,
        amount:      String(amount),
        type:        "CASH",
        status:      "COMPLETED",
        initiatedBy: "agent",
        note:        `idempkey:${idempKey}`,
        completedAt: new Date(),
      });
    }

    const transfer = await db.select().from(liquidityTransfersTable)
      .where(eq(liquidityTransfersTable.note, `idempkey:${idempKey}`))
      .limit(1).then(r => r[0] ?? null);

    return res.status(201).json({ transfer, ok: true });
  } catch (err) { return next(err); }
});

// ── GET /agents/:id/commissions ───────────────────────────────────────────────
router.get("/:id/commissions", async (req, res, next) => {
  try {
    const { status, from, to, limit: lim } = req.query as Record<string, string>;
    const limit = Math.min(Number(lim) || 50, 200);

    const conditions: any[] = [eq(agentCommissionsTable.agentId, req.params.id)];
    if (status) conditions.push(eq(agentCommissionsTable.status, status));
    if (from)   conditions.push(gte(agentCommissionsTable.createdAt, new Date(from)));

    const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
    const monthStart    = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const [commissions, totals] = await Promise.all([
      db.select().from(agentCommissionsTable)
        .where(and(...conditions))
        .orderBy(desc(agentCommissionsTable.createdAt))
        .limit(limit),
      db.select({
        earnedThisMonth: sql<number>`COALESCE(SUM(CAST(agent_share AS NUMERIC)) FILTER (WHERE created_at >= ${monthStart}), 0)`,
        pending:         sql<number>`COALESCE(SUM(CAST(agent_share AS NUMERIC)) FILTER (WHERE status = 'pending'), 0)`,
        paid:            sql<number>`COALESCE(SUM(CAST(agent_share AS NUMERIC)) FILTER (WHERE status = 'paid'), 0)`,
        today:           sql<number>`COALESCE(SUM(CAST(agent_share AS NUMERIC)) FILTER (WHERE created_at >= ${todayMidnight}), 0)`,
      })
      .from(agentCommissionsTable)
      .where(eq(agentCommissionsTable.agentId, req.params.id)),
    ]);

    return res.json({
      commissions,
      totals: {
        earnedThisMonth: Number(totals[0]?.earnedThisMonth ?? 0),
        pending:         Number(totals[0]?.pending         ?? 0),
        paid:            Number(totals[0]?.paid            ?? 0),
        today:           Number(totals[0]?.today           ?? 0),
      },
      count: commissions.length,
    });
  } catch (err) { return next(err); }
});

// ── POST /agents/:id/cash-update ──────────────────────────────────────────────
router.post("/:id/cash-update", async (req, res, next) => {
  try {
    const { cashBalance } = req.body as { cashBalance: number };
    if (cashBalance == null || cashBalance < 0) {
      return res.status(400).json({ error: "cashBalance >= 0 required" });
    }

    await db.update(agentWalletsTable)
      .set({ cashBalance: String(cashBalance), updatedAt: new Date() })
      .where(eq(agentWalletsTable.agentId, req.params.id));

    // Auto-trigger liquidity check
    const liquidity = await checkLiquidity(req.params.id);

    return res.json({ ok: true, cashBalance, liquidity });
  } catch (err) { return next(err); }
});

// ── POST /liquidity/rebalance ─────────────────────────────────────────────────
// Mounts as /agents/liquidity/rebalance (the router is at /api/agents)
router.post("/liquidity/rebalance", async (req, res, next) => {
  try {
    await runLiquidityMonitor();
    return res.json({ ok: true, message: "Zone rebalance analysis complete — alerts created where needed" });
  } catch (err) { return next(err); }
});

// ── BLOCK 1: Trust Score + Withdrawal Approval ────────────────────────────────

// POST /agents/:id/anomalies — record a new anomaly
router.post("/:id/anomalies", async (req, res, next) => {
  try {
    const { type, severity, description, evidence } = req.body as {
      type:        "CASH_MISMATCH" | "RAPID_WITHDRAWALS" | "LARGE_ROUND_AMOUNTS" | "CLIENT_COMPLAINT" | "RECONCILIATION_FAIL" | "COLLUSION_PATTERN";
      severity:    "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      description: string;
      evidence?:   Record<string, unknown>;
    };
    if (!type || !severity || !description) {
      return res.status(400).json({ error: "type, severity, description required" });
    }
    const anomalyId = await createAnomaly(req.params.id, type, severity, description, evidence);
    return res.status(201).json({ anomalyId, trustUpdated: true });
  } catch (err) { return next(err); }
});

// GET /agents/:id/anomalies — list agent anomalies
router.get("/:id/anomalies", async (req, res, next) => {
  try {
    const anomalies = await db
      .select()
      .from(agentAnomaliesTable)
      .where(eq(agentAnomaliesTable.agentId, req.params.id))
      .orderBy(desc(agentAnomaliesTable.createdAt));
    return res.json({ anomalies, count: anomalies.length });
  } catch (err) { return next(err); }
});

// POST /agents/:id/withdrawal-approval — generate approval code for large withdrawal
router.post("/:id/withdrawal-approval", async (req, res, next) => {
  try {
    const { transactionId, supervisorPin } = req.body as { transactionId: string; supervisorPin?: string };
    if (!transactionId) return res.status(400).json({ error: "transactionId required" });

    const agent = await db.select({ trustLevel: agentsTable.trustLevel })
      .from(agentsTable).where(eq(agentsTable.id, req.params.id)).limit(1).then(r => r[0]);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.trustLevel === "BLOCKED") {
      return res.status(403).json({ error: "Agent bloqué — approbation refusée" });
    }

    const result = await createWithdrawalApproval(req.params.id, transactionId, supervisorPin ? "supervisor" : undefined);
    return res.json(result);
  } catch (err) { return next(err); }
});

// POST /agents/:id/withdrawal-approval/validate — check a code before executing withdrawal
router.post("/:id/withdrawal-approval/validate", async (req, res, next) => {
  try {
    const { transactionId, approvalCode } = req.body as { transactionId: string; approvalCode: string };
    if (!transactionId || !approvalCode) {
      return res.status(400).json({ error: "transactionId and approvalCode required" });
    }
    const result = await checkLargeWithdrawalApproval(req.params.id, transactionId, approvalCode);
    if (!result.approved) return res.status(403).json({ error: result.reason });
    return res.json({ approved: true });
  } catch (err) { return next(err); }
});

// PATCH /agents/:id/trust-score/refresh — recompute trust score
router.patch("/:id/trust-score/refresh", async (req, res, next) => {
  try {
    await updateAgentTrustScore(req.params.id);
    const agent = await db
      .select({ trustScore: agentsTable.trustScore, trustLevel: agentsTable.trustLevel })
      .from(agentsTable).where(eq(agentsTable.id, req.params.id)).limit(1).then(r => r[0]);
    return res.json({ trustScore: agent?.trustScore, trustLevel: agent?.trustLevel });
  } catch (err) { return next(err); }
});

// ── BLOCK 2: Cash Reconciliation ──────────────────────────────────────────────

// GET /agents/:id/reconciliations
router.get("/:id/reconciliations", async (req, res, next) => {
  try {
    const limit  = Number(req.query["limit"]  ?? 30);
    const offset = Number(req.query["offset"] ?? 0);
    const records = await db
      .select()
      .from(cashReconciliationsTable)
      .where(eq(cashReconciliationsTable.agentId, req.params.id))
      .orderBy(desc(cashReconciliationsTable.createdAt))
      .limit(limit).offset(offset);
    return res.json({ reconciliations: records, count: records.length });
  } catch (err) { return next(err); }
});

// POST /agents/:id/reconcile
router.post("/:id/reconcile", async (req, res, next) => {
  try {
    const { date, declaredCash, agentNote, photoProof } = req.body as {
      date:         string;
      declaredCash: number;
      agentNote?:   string;
      photoProof?:  string;
    };
    if (!date || declaredCash == null) {
      return res.status(400).json({ error: "date and declaredCash required" });
    }
    const result = await submitReconciliation(req.params.id, date, declaredCash, agentNote, photoProof);
    return res.json({ ok: true, ...result });
  } catch (err) { return next(err); }
});

// PATCH /agents/:id/reconciliations/:date/dispute
router.patch("/:id/reconciliations/:date/dispute", async (req, res, next) => {
  try {
    const { agentNote } = req.body as { agentNote?: string };
    const updated = await db
      .update(cashReconciliationsTable)
      .set({ status: "DISPUTED", agentNote: agentNote ?? null })
      .where(and(
        eq(cashReconciliationsTable.agentId, req.params.id),
        eq(cashReconciliationsTable.date, req.params.date),
      ))
      .returning();
    if (!updated.length) return res.status(404).json({ error: "Reconciliation not found" });
    return res.json({ ok: true, reconciliation: updated[0] });
  } catch (err) { return next(err); }
});

// ── BLOCK 4: Gamification ─────────────────────────────────────────────────────

// GET /agents/:id/achievements
router.get("/:id/achievements", async (req, res, next) => {
  try {
    const achievements = await db
      .select()
      .from(agentAchievementsTable)
      .where(eq(agentAchievementsTable.agentId, req.params.id))
      .orderBy(desc(agentAchievementsTable.earnedAt));
    return res.json({ achievements, count: achievements.length });
  } catch (err) { return next(err); }
});

// POST /agents/:id/achievements/check — manually trigger achievement check
router.post("/:id/achievements/check", async (req, res, next) => {
  try {
    const awarded = await checkAchievements(req.params.id);
    return res.json({ awarded, newBadges: awarded.length });
  } catch (err) { return next(err); }
});

export default router;
