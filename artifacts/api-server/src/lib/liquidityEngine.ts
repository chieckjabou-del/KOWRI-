// ── KOWRI Agent Liquidity Engine ──────────────────────────────────────────────
//
// Independent module — does NOT touch ledger_entries, walletService internals,
// or autopilot core.  Designed to plug in as autopilot layer 11.
//
// ROLLBACK: remove import from autopilot.ts; delete this file.

import { db }                     from "@workspace/db";
import {
  agentsTable,
  agentWalletsTable,
  liquidityTransfersTable,
  liquidityAlertsTable,
  agentCommissionsTable,
  agentAnomaliesTable,
  withdrawalApprovalsTable,
  cashReconciliationsTable,
  agentAchievementsTable,
  agentRankingsTable,
}                                  from "@workspace/db";
import { eq, and, sql, ne, gte, lt, isNull } from "drizzle-orm";
import { generateId }              from "./id";
import { processTransfer }         from "./walletService";
import { logIncident }             from "./incidentStore";
import { createNotification }      from "./productWallet";

// ── Commission config ──────────────────────────────────────────────────────────

const WITHDRAWAL_TIERS = [
  { min: 1_000,    max: 10_000,     flatFee: 100 },
  { min: 10_001,   max: 50_000,     flatFee: 300 },
  { min: 50_001,   max: 200_000,    flatFee: 500 },
  { min: 200_001,  max: Infinity,   rateBps: 25  },   // 0.25 %
];

const TIER_THRESHOLDS = [
  { tier: 3, minVolume: 20_000_000, multiplier: 1.20 },
  { tier: 2, minVolume:  5_000_000, multiplier: 1.10 },
  { tier: 1, minVolume:          0, multiplier: 1.00 },
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CommissionBreakdown {
  grossAmount:     number;
  commissionAmount: number;
  agentShare:      number;
  superAgentShare: number;
  kowriShare:      number;
}

export interface LiquidityStatus {
  cashOk:      boolean;
  floatOk:     boolean;
  cashBalance: number;
  floatBalance: number;
  alerts:      string[];
  suggestions: string[];
}

export interface RebalanceSuggestion {
  suggestedFromAgent: string | null;
  amount:             number;
  estimatedTime:      string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTierMultiplier(monthlyVolume: number): { tier: number; multiplier: number } {
  for (const t of TIER_THRESHOLDS) {
    if (monthlyVolume >= t.minVolume) return t;
  }
  return { tier: 1, multiplier: 1.00 };
}

async function getAgentWallet(agentId: string) {
  const rows = await db
    .select()
    .from(agentWalletsTable)
    .where(eq(agentWalletsTable.agentId, agentId))
    .limit(1);
  return rows[0] ?? null;
}

function alertMessage(
  type: "LOW_CASH" | "LOW_FLOAT" | "ZONE_TENSION" | "SURPLUS",
  level: "WARNING" | "CRITICAL",
  extra?: string,
): { message: string; suggestedAction: string } {
  const msgs: Record<string, { message: string; suggestedAction: string }> = {
    LOW_CASH_WARNING:    { message: "Solde cash en dessous du seuil minimum",            suggestedAction: "Effectuez un approvisionnement cash auprès de votre Super Agent" },
    LOW_CASH_CRITICAL:   { message: "Solde cash critique — activité en danger",           suggestedAction: "Approvisionnement urgent requis — contactez votre Super Agent immédiatement" },
    LOW_FLOAT_WARNING:   { message: "Float digital en dessous du seuil minimum",          suggestedAction: "Demandez un transfert de float à votre Super Agent" },
    LOW_FLOAT_CRITICAL:  { message: "Float critique — vous ne pouvez plus traiter de retraits", suggestedAction: "Transfert de float urgent — déclenchez une demande immédiatement" },
    ZONE_TENSION_WARNING: { message: extra ?? "Tension de liquidité détectée dans votre zone", suggestedAction: "Coordination de zone requise — Super Agent alerté" },
    ZONE_TENSION_CRITICAL: { message: extra ?? "Crise de liquidité dans votre zone",         suggestedAction: "Intervention Master Agent requise" },
    SURPLUS_WARNING:     { message: "Solde cash dépasse 2x le seuil maximum",             suggestedAction: "Effectuez un reverse-transfer vers votre Super Agent" },
    SURPLUS_CRITICAL:    { message: "Surplus critique — risque opérationnel",              suggestedAction: "Reverse-transfer urgent — solde trop élevé" },
  };
  return msgs[`${type}_${level}`] ?? { message: type, suggestedAction: "" };
}

// ── Core functions ─────────────────────────────────────────────────────────────

export async function checkLiquidity(agentId: string): Promise<LiquidityStatus> {
  const wallet = await getAgentWallet(agentId);
  if (!wallet) {
    return { cashOk: false, floatOk: false, cashBalance: 0, floatBalance: 0, alerts: ["Portefeuille agent introuvable"], suggestions: [] };
  }

  const cash      = Number(wallet.cashBalance  ?? 0);
  const float_    = Number(wallet.floatBalance ?? 0);
  const minCash   = Number(wallet.minCashThreshold  ?? 0);
  const minFloat  = Number(wallet.minFloatThreshold ?? 0);
  const maxCash   = Number(wallet.maxCashBalance ?? Infinity);

  const alerts:      string[] = [];
  const suggestions: string[] = [];

  if (cash < minCash) {
    alerts.push(cash < minCash * 0.5 ? "LOW_CASH_CRITICAL" : "LOW_CASH_WARNING");
    suggestions.push("Demander un approvisionnement cash à votre Super Agent");
  }
  if (float_ < minFloat) {
    alerts.push(float_ < minFloat * 0.5 ? "LOW_FLOAT_CRITICAL" : "LOW_FLOAT_WARNING");
    suggestions.push("Demander un transfert de float");
  }
  if (cash > maxCash * 2 || cash > minCash * 2) {
    alerts.push("SURPLUS_WARNING");
    suggestions.push("Effectuer un reverse-transfer vers votre Super Agent");
  }

  return {
    cashOk:       cash >= minCash,
    floatOk:      float_ >= minFloat,
    cashBalance:  cash,
    floatBalance: float_,
    alerts,
    suggestions,
  };
}

export async function createLiquidityAlert(
  agentId:  string,
  type:     "LOW_CASH" | "LOW_FLOAT" | "ZONE_TENSION" | "SURPLUS",
  level:    "WARNING" | "CRITICAL",
  extra?:   string,
): Promise<void> {
  // Idempotent — skip if same unresolved alert already exists for this agent+type
  const existing = await db
    .select({ id: liquidityAlertsTable.id })
    .from(liquidityAlertsTable)
    .where(
      and(
        eq(liquidityAlertsTable.agentId,  agentId),
        eq(liquidityAlertsTable.type,     type),
        eq(liquidityAlertsTable.resolved, false),
      ),
    )
    .limit(1);

  if (existing.length > 0) return;

  const { message, suggestedAction } = alertMessage(type, level, extra);

  await db.insert(liquidityAlertsTable).values({
    id:              generateId(),
    agentId,
    type,
    level,
    message,
    suggestedAction,
    resolved:        false,
  });
}

export async function suggestRebalance(agentId: string): Promise<RebalanceSuggestion> {
  const agent = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1)
    .then(r => r[0] ?? null);

  if (!agent) return { suggestedFromAgent: null, amount: 0, estimatedTime: "N/A" };

  // Find nearest SUPER_AGENT in same zone with surplus float
  const superAgents = await db
    .select({
      agentId:      agentWalletsTable.agentId,
      floatBalance: agentWalletsTable.floatBalance,
      minFloat:     agentWalletsTable.minFloatThreshold,
    })
    .from(agentWalletsTable)
    .innerJoin(agentsTable, eq(agentsTable.id, agentWalletsTable.agentId))
    .where(
      and(
        eq(agentsTable.type,   "SUPER_AGENT"),
        eq(agentsTable.status, "ACTIVE"),
        eq(agentsTable.zone,   agent.zone),
        ne(agentsTable.id,     agentId),
      ),
    )
    .limit(10);

  const agentWallet = await getAgentWallet(agentId);
  const needed      = Math.max(0, Number(agentWallet?.minFloatThreshold ?? 0) - Number(agentWallet?.floatBalance ?? 0));

  for (const sa of superAgents) {
    const surplus = Number(sa.floatBalance) - Number(sa.minFloat ?? 0);
    if (surplus > 0) {
      const transferAmount = Math.min(surplus * 0.5, needed * 1.5);
      return {
        suggestedFromAgent: sa.agentId,
        amount:             Math.round(transferAmount),
        estimatedTime:      "15–30 minutes",
      };
    }
  }

  // Fall back — any SUPER_AGENT in any zone
  const fallback = await db
    .select({ agentId: agentWalletsTable.agentId, floatBalance: agentWalletsTable.floatBalance })
    .from(agentWalletsTable)
    .innerJoin(agentsTable, eq(agentsTable.id, agentWalletsTable.agentId))
    .where(and(eq(agentsTable.type, "SUPER_AGENT"), eq(agentsTable.status, "ACTIVE")))
    .limit(1)
    .then(r => r[0] ?? null);

  return {
    suggestedFromAgent: fallback?.agentId ?? null,
    amount:             needed,
    estimatedTime:      fallback ? "30–60 minutes (zone différente)" : "N/A",
  };
}

export async function executeFloatTransfer(
  fromAgentId: string,
  toAgentId:   string,
  amount:      number,
): Promise<void> {
  const [fromWallet, toWallet] = await Promise.all([
    getAgentWallet(fromAgentId),
    getAgentWallet(toAgentId),
  ]);

  if (!fromWallet || !toWallet) {
    throw new Error("Agent wallet not found for float transfer");
  }
  if (Number(fromWallet.floatBalance) < amount) {
    throw new Error("Float insuffisant pour le transfert");
  }

  // Record transfer as PENDING
  const transferId = generateId();
  await db.insert(liquidityTransfersTable).values({
    id:          transferId,
    fromAgentId,
    toAgentId,
    amount:      String(amount),
    type:        "FLOAT",
    status:      "PENDING",
    initiatedBy: "agent",
    note:        "Float transfer via liquidityEngine",
  });

  try {
    // Use existing wallet service for actual ledger movement
    await processTransfer({
      fromWalletId:    fromWallet.walletId,
      toWalletId:      toWallet.walletId,
      amount,
      currency:        "XOF",
      description:     `Float transfer: ${fromAgentId} → ${toAgentId}`,
      skipRateLimitCheck: true,
      skipFraudCheck:     true,
    });

    // Update float balances on both agent wallets
    await Promise.all([
      db.update(agentWalletsTable)
        .set({
          floatBalance: sql`CAST(float_balance AS NUMERIC) - ${amount}`,
          updatedAt:    new Date(),
        })
        .where(eq(agentWalletsTable.agentId, fromAgentId)),
      db.update(agentWalletsTable)
        .set({
          floatBalance: sql`CAST(float_balance AS NUMERIC) + ${amount}`,
          updatedAt:    new Date(),
        })
        .where(eq(agentWalletsTable.agentId, toAgentId)),
    ]);

    // Mark transfer completed
    await db.update(liquidityTransfersTable)
      .set({ status: "COMPLETED", completedAt: new Date() })
      .where(eq(liquidityTransfersTable.id, transferId));

  } catch (err) {
    await db.update(liquidityTransfersTable)
      .set({ status: "FAILED" })
      .where(eq(liquidityTransfersTable.id, transferId));
    throw err;
  }
}

export async function computeCommission(
  agentId:       string,
  operationType: "deposit" | "withdrawal" | "registration" | "tontine",
  amount:        number,
): Promise<CommissionBreakdown> {
  const agent = await db
    .select({ commissionTier: agentsTable.commissionTier, monthlyVolume: agentsTable.monthlyVolume })
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1)
    .then(r => r[0] ?? null);

  const { multiplier } = getTierMultiplier(Number(agent?.monthlyVolume ?? 0));

  let baseCommission: number;
  let agentPct:       number;
  let superPct:       number;
  let kowriPct:       number;

  switch (operationType) {
    case "deposit": {
      const rate  = (20 / 10_000) * multiplier; // 0.2 % × tier
      baseCommission = Math.max(200, Math.round(amount * rate));
      agentPct = 0.60; superPct = 0.20; kowriPct = 0.20;
      break;
    }
    case "withdrawal": {
      const tier = WITHDRAWAL_TIERS.find(t => amount >= t.min && amount <= t.max);
      if (!tier) { baseCommission = 0; agentPct = 0.40; superPct = 0.20; kowriPct = 0.40; break; }
      baseCommission = tier.flatFee != null
        ? tier.flatFee
        : Math.round(amount * ((tier.rateBps ?? 0) / 10_000));
      baseCommission = Math.round(baseCommission * multiplier);
      agentPct = 0.40; superPct = 0.20; kowriPct = 0.40;
      break;
    }
    case "registration": {
      baseCommission = Math.round(1_000 * multiplier);
      agentPct = 1.00; superPct = 0.00; kowriPct = 0.00;
      break;
    }
    case "tontine": {
      baseCommission = Math.round(amount * (30 / 10_000) * multiplier); // 0.3 %
      agentPct = 0.50; superPct = 0.00; kowriPct = 0.50;
      break;
    }
    default:
      throw new Error(`Unknown operationType: ${operationType}`);
  }

  return {
    grossAmount:      amount,
    commissionAmount: baseCommission,
    agentShare:       Math.round(baseCommission * agentPct),
    superAgentShare:  Math.round(baseCommission * superPct),
    kowriShare:       Math.round(baseCommission * kowriPct),
  };
}

export async function updateMonthlyVolume(agentId: string, amount: number): Promise<void> {
  const agent = await db
    .select({ monthlyVolume: agentsTable.monthlyVolume, commissionTier: agentsTable.commissionTier })
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1)
    .then(r => r[0] ?? null);

  if (!agent) return;

  const oldVolume = Number(agent.monthlyVolume ?? 0);
  const newVolume = oldVolume + amount;
  const oldTier   = agent.commissionTier ?? 1;
  const { tier: newTier } = getTierMultiplier(newVolume);

  await db.update(agentsTable)
    .set({
      monthlyVolume:  String(newVolume),
      commissionTier: newTier,
    })
    .where(eq(agentsTable.id, agentId));

  if (newTier !== oldTier) {
    logIncident({
      type:   "agent_tier_upgrade",
      action: `tier_${oldTier}_to_${newTier}`,
      result: `agentId=${agentId} volume=${newVolume}`,
    });
    // Block 4 — notify agent about tier upgrade
    const fullAgent = await db.select({ userId: agentsTable.userId })
      .from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1).then(r => r[0]);
    if (fullAgent?.userId) {
      await createNotification(
        fullAgent.userId,
        "agent_tier_upgrade",
        "Niveau de commission amélioré !",
        `Félicitations ! Votre commission passe au niveau ${newTier}. Vos frais augmentent de ${(newTier - 1) * 10}%.`,
      ).catch(() => {});
    }
  }
}

export async function detectZoneTension(zone: string): Promise<boolean> {
  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(liquidityAlertsTable)
    .innerJoin(agentsTable, eq(agentsTable.id, liquidityAlertsTable.agentId))
    .where(
      and(
        eq(agentsTable.zone,               zone),
        eq(liquidityAlertsTable.type,      "LOW_CASH"),
        eq(liquidityAlertsTable.resolved,  false),
      ),
    );

  const tensionCount = Number(count ?? 0);
  if (tensionCount >= 3) {
    // Alert the Super Agent(s) in this zone
    const superAgents = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(and(eq(agentsTable.zone, zone), eq(agentsTable.type, "SUPER_AGENT"), eq(agentsTable.status, "ACTIVE")))
      .limit(5);

    for (const sa of superAgents) {
      await createLiquidityAlert(
        sa.id,
        "ZONE_TENSION",
        tensionCount >= 5 ? "CRITICAL" : "WARNING",
        `${tensionCount} agents en alerte LOW_CASH dans la zone ${zone}`,
      );
    }
    return true;
  }
  return false;
}

// ── Autopilot layer 11: Liquidity Monitor ────────────────────────────────────

export async function runLiquidityMonitor(): Promise<void> {
  const agents = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.status, "ACTIVE"));

  if (agents.length === 0) return; // No agents yet — skip silently

  for (const agent of agents) {
    try {
      const wallet = await getAgentWallet(agent.id);
      if (!wallet) continue;

      const cash     = Number(wallet.cashBalance  ?? 0);
      const float_   = Number(wallet.floatBalance ?? 0);
      const minCash  = Number(wallet.minCashThreshold  ?? 0);
      const minFloat = Number(wallet.minFloatThreshold ?? 0);
      const maxCash  = Number(wallet.maxCashBalance ?? minCash * 4);

      // Low cash check
      if (minCash > 0 && cash < minCash) {
        const level = cash < minCash * 0.5 ? "CRITICAL" : "WARNING";
        await createLiquidityAlert(agent.id, "LOW_CASH", level);
      }

      // Low float check
      if (minFloat > 0 && float_ < minFloat) {
        const level = float_ < minFloat * 0.5 ? "CRITICAL" : "WARNING";
        await createLiquidityAlert(agent.id, "LOW_FLOAT", level);
      }

      // Surplus check
      if (minCash > 0 && cash > minCash * 2) {
        await createLiquidityAlert(agent.id, "SURPLUS", "WARNING");
      }
    } catch (err) {
      console.error(`[LiquidityMonitor] agent ${agent.id} check failed:`, err);
    }
  }

  // Zone tension detection
  const zones = [...new Set(agents.map(a => a.zone))];
  for (const zone of zones) {
    try {
      await detectZoneTension(zone);
    } catch (err) {
      console.error(`[LiquidityMonitor] zone tension check failed (${zone}):`, err);
    }
  }

  console.info(`[LiquidityMonitor] checked ${agents.length} agents, ${zones.length} zones`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCK 1 — Agent Trust Score + Fraud Detection
// ═══════════════════════════════════════════════════════════════════════════════

export async function createAnomaly(
  agentId:     string,
  type:        "CASH_MISMATCH" | "RAPID_WITHDRAWALS" | "LARGE_ROUND_AMOUNTS" | "CLIENT_COMPLAINT" | "RECONCILIATION_FAIL" | "COLLUSION_PATTERN",
  severity:    "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  description: string,
  evidence?:   Record<string, unknown>,
): Promise<string> {
  const id = generateId("anom");
  await db.insert(agentAnomaliesTable).values({
    id, agentId, type, severity, description,
    evidence: evidence ?? {},
    resolved:  false,
    createdAt: new Date(),
  });
  await db.update(agentsTable)
    .set({ anomalyCount: sql`coalesce(anomaly_count, 0) + 1` })
    .where(eq(agentsTable.id, agentId));
  // Automatically recompute trust after each new anomaly
  await updateAgentTrustScore(agentId).catch(() => {});
  return id;
}

async function getUnresolvedAnomalies(agentId: string) {
  return db
    .select()
    .from(agentAnomaliesTable)
    .where(and(eq(agentAnomaliesTable.agentId, agentId), eq(agentAnomaliesTable.resolved, false)));
}

async function getFailedReconciliations(agentId: string, days: number) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  return db
    .select()
    .from(cashReconciliationsTable)
    .where(
      and(
        eq(cashReconciliationsTable.agentId, agentId),
        eq(cashReconciliationsTable.status, "MISMATCH"),
        gte(cashReconciliationsTable.createdAt!, since),
      ),
    );
}

async function suspendAgent(agentId: string, reason: string): Promise<void> {
  await db.update(agentsTable)
    .set({ status: "SUSPENDED" })
    .where(eq(agentsTable.id, agentId));
  logIncident({
    type:   "agent_suspended",
    action: "trust_score_block",
    result: `agentId=${agentId} reason=${reason}`,
  });
  const agent = await db.select({ userId: agentsTable.userId, name: agentsTable.name })
    .from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1).then(r => r[0]);
  if (agent?.userId) {
    await createNotification(
      agent.userId,
      "agent_suspended",
      "Compte agent suspendu",
      `Votre compte agent a été suspendu : ${reason}. Contactez le support.`,
    ).catch(() => {});
  }
}

export async function updateAgentTrustScore(agentId: string): Promise<void> {
  let score = 100;

  const anomalies = await getUnresolvedAnomalies(agentId);
  for (const a of anomalies) {
    if (a.severity === "CRITICAL") score -= 30;
    else if (a.severity === "HIGH")   score -= 15;
    else if (a.severity === "MEDIUM") score -= 8;
    else if (a.severity === "LOW")    score -= 3;
  }

  const failedRecons = await getFailedReconciliations(agentId, 30);
  score -= failedRecons.length * 5;

  // Bonus for clean high-volume agent
  const agent = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1).then(r => r[0]);
  if (!agent) return;

  const monthlyVolume = Number(agent.monthlyVolume ?? 0);
  if (monthlyVolume > 5_000_000 && anomalies.length === 0) score += 5;

  score = Math.max(0, Math.min(100, score));

  const trustLevel: "TRUSTED" | "WATCH" | "FLAGGED" | "BLOCKED" =
    score >= 80 ? "TRUSTED" :
    score >= 60 ? "WATCH"   :
    score >= 40 ? "FLAGGED" : "BLOCKED";

  await db.update(agentsTable)
    .set({ trustScore: score, trustLevel })
    .where(eq(agentsTable.id, agentId));

  if (trustLevel === "BLOCKED" && agent.status === "ACTIVE") {
    await suspendAgent(agentId, "Score de confiance en dessous du seuil minimum");
  }
}

// Large withdrawal approval (5-minute TTL code)
function generateApprovalCode(): string {
  return Math.floor(100_000 + Math.random() * 900_000).toString();
}

export async function createWithdrawalApproval(
  agentId:       string,
  transactionId: string,
  approvedBy?:   string,
): Promise<{ approvalCode: string; expiresIn: number }> {
  const approvalCode = generateApprovalCode();
  const expiresAt    = new Date(Date.now() + 5 * 60 * 1000); // 5 min

  await db.insert(withdrawalApprovalsTable).values({
    id:            generateId("wdapprv"),
    transactionId,
    agentId,
    approvedBy:    approvedBy ?? null,
    approvalCode,
    expiresAt,
    createdAt:     new Date(),
  });

  return { approvalCode, expiresIn: 300 };
}

export async function checkLargeWithdrawalApproval(
  agentId:       string,
  transactionId: string,
  code:          string,
): Promise<{ approved: boolean; reason?: string }> {
  const now = new Date();
  const rows = await db
    .select()
    .from(withdrawalApprovalsTable)
    .where(
      and(
        eq(withdrawalApprovalsTable.agentId,       agentId),
        eq(withdrawalApprovalsTable.transactionId, transactionId),
        eq(withdrawalApprovalsTable.approvalCode,  code),
        isNull(withdrawalApprovalsTable.usedAt),
        gte(withdrawalApprovalsTable.expiresAt,    now),
      ),
    )
    .limit(1);

  if (!rows.length) return { approved: false, reason: "Code invalide ou expiré" };

  await db.update(withdrawalApprovalsTable)
    .set({ usedAt: now })
    .where(eq(withdrawalApprovalsTable.id, rows[0].id));

  return { approved: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCK 2 — Cash Reconciliation
// ═══════════════════════════════════════════════════════════════════════════════

export async function createPendingReconciliation(agentId: string, dateStr: string): Promise<void> {
  // Expected cash = agent wallet cashBalance (as a proxy; in prod this would sum tx)
  const wallet = await getAgentWallet(agentId);
  const expectedCash = Number(wallet?.cashBalance ?? 0);

  // Upsert — only create if one doesn't already exist for this date
  const existing = await db
    .select({ id: cashReconciliationsTable.id })
    .from(cashReconciliationsTable)
    .where(and(eq(cashReconciliationsTable.agentId, agentId), eq(cashReconciliationsTable.date, dateStr)))
    .limit(1);

  if (existing.length > 0) return; // Already created

  await db.insert(cashReconciliationsTable).values({
    id:                 generateId("recon"),
    agentId,
    date:               dateStr,
    systemExpectedCash: String(expectedCash),
    status:             "PENDING",
    createdAt:          new Date(),
  });

  // Notify the agent to declare their cash
  const agent = await db.select({ userId: agentsTable.userId })
    .from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1).then(r => r[0]);
  if (agent?.userId) {
    await createNotification(
      agent.userId,
      "reconciliation_pending",
      "Rapprochement quotidien",
      `Veuillez confirmer votre cash avant 22h00. Solde système : ${expectedCash.toLocaleString()} XOF`,
    ).catch(() => {});
  }
}

export async function submitReconciliation(
  agentId:       string,
  dateStr:       string,
  declaredCash:  number,
  agentNote?:    string,
  photoProof?:   string,
): Promise<{ status: "MATCHED" | "MISMATCH"; delta: number }> {
  const existing = await db
    .select()
    .from(cashReconciliationsTable)
    .where(and(eq(cashReconciliationsTable.agentId, agentId), eq(cashReconciliationsTable.date, dateStr)))
    .limit(1);

  const expectedCash = Number(existing[0]?.systemExpectedCash ?? 0);
  const delta = Math.abs(declaredCash - expectedCash);

  let status: "MATCHED" | "MISMATCH" = delta < 500 ? "MATCHED" : "MISMATCH";

  if (existing.length === 0) {
    await db.insert(cashReconciliationsTable).values({
      id:                 generateId("recon"),
      agentId,
      date:               dateStr,
      systemExpectedCash: String(expectedCash),
      agentDeclaredCash:  String(declaredCash),
      delta:              String(delta),
      status,
      agentNote:          agentNote ?? null,
      photoProof:         photoProof ?? null,
      createdAt:          new Date(),
    });
  } else {
    await db.update(cashReconciliationsTable)
      .set({
        agentDeclaredCash: String(declaredCash),
        delta:             String(delta),
        status,
        agentNote:         agentNote ?? null,
        photoProof:        photoProof ?? null,
      })
      .where(eq(cashReconciliationsTable.id, existing[0].id));
  }

  // Critical mismatch → create anomaly
  if (status === "MISMATCH") {
    const severity = delta > 5_000 ? "HIGH" : "MEDIUM";
    await createAnomaly(
      agentId,
      "CASH_MISMATCH",
      severity,
      `Écart de ${delta.toLocaleString()} XOF lors du rapprochement du ${dateStr}`,
      { expectedCash, declaredCash, delta },
    ).catch(() => {});
  }

  return { status, delta };
}

export async function runDailyReconciliation(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const agents = await db.select({ id: agentsTable.id })
    .from(agentsTable)
    .where(eq(agentsTable.status, "ACTIVE"));

  let created = 0;
  for (const agent of agents) {
    try {
      await createPendingReconciliation(agent.id, today);
      created++;
    } catch (err) {
      console.error(`[DailyRecon] agent ${agent.id} failed:`, err);
    }
  }
  console.info(`[DailyRecon] created ${created}/${agents.length} reconciliation records for ${today}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCK 4 — Agent Gamification
// ═══════════════════════════════════════════════════════════════════════════════

type AgentBadge = "FIRST_100_CLIENTS" | "VOLUME_5M" | "VOLUME_20M" | "ZERO_ANOMALIES_30D" | "TOP_ZONE_AGENT" | "TRUSTED_VETERAN" | "TONTINE_CHAMPION";

async function badgeExists(agentId: string, badge: AgentBadge): Promise<boolean> {
  const rows = await db
    .select({ id: agentAchievementsTable.id })
    .from(agentAchievementsTable)
    .where(and(eq(agentAchievementsTable.agentId, agentId), eq(agentAchievementsTable.badge, badge)))
    .limit(1);
  return rows.length > 0;
}

async function awardBadge(agentId: string, badge: AgentBadge): Promise<void> {
  await db.insert(agentAchievementsTable).values({
    id:       generateId("badge"),
    agentId,
    badge,
    earnedAt: new Date(),
    notified: false,
  });

  const agent = await db.select({ userId: agentsTable.userId })
    .from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1).then(r => r[0]);

  if (agent?.userId) {
    const labels: Record<AgentBadge, string> = {
      FIRST_100_CLIENTS:  "100 Premiers Clients",
      VOLUME_5M:          "Volume 5 Millions",
      VOLUME_20M:         "Volume 20 Millions",
      ZERO_ANOMALIES_30D: "30 Jours Sans Anomalie",
      TOP_ZONE_AGENT:     "Meilleur Agent de Zone",
      TRUSTED_VETERAN:    "Vétéran de Confiance",
      TONTINE_CHAMPION:   "Champion des Tontines",
    };
    await createNotification(
      agent.userId,
      "achievement_unlocked",
      "Nouveau badge débloqué !",
      `Félicitations ! Vous avez gagné le badge "${labels[badge]}".`,
    ).catch(() => {});

    await db.update(agentAchievementsTable)
      .set({ notified: true })
      .where(and(eq(agentAchievementsTable.agentId, agentId), eq(agentAchievementsTable.badge, badge)));
  }
}

export async function checkAchievements(agentId: string): Promise<string[]> {
  const agent = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1).then(r => r[0]);
  if (!agent) return [];

  const monthlyVol   = Number(agent.monthlyVolume ?? 0);
  const trustScore_  = Number(agent.trustScore ?? 100);

  // Days since creation
  const createdAt   = agent.createdAt ?? new Date();
  const ageMs       = Date.now() - new Date(createdAt).getTime();
  const monthsActive = ageMs / (1000 * 60 * 60 * 24 * 30);

  // Count anomalies in last 30 days
  const since30 = new Date(); since30.setDate(since30.getDate() - 30);
  const recentAnomalies = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(agentAnomaliesTable)
    .where(and(eq(agentAnomaliesTable.agentId, agentId), gte(agentAnomaliesTable.createdAt!, since30)));
  const anomaliesLast30 = Number(recentAnomalies[0]?.cnt ?? 0);

  const awarded: string[] = [];

  const checks: { badge: AgentBadge; condition: boolean }[] = [
    { badge: "VOLUME_5M",          condition: monthlyVol >= 5_000_000 },
    { badge: "VOLUME_20M",         condition: monthlyVol >= 20_000_000 },
    { badge: "ZERO_ANOMALIES_30D", condition: anomaliesLast30 === 0 && monthsActive >= 1 },
    { badge: "TRUSTED_VETERAN",    condition: monthsActive >= 6 && trustScore_ === 100 },
  ];

  for (const check of checks) {
    if (check.condition) {
      const exists = await badgeExists(agentId, check.badge);
      if (!exists) {
        await awardBadge(agentId, check.badge);
        awarded.push(check.badge);
      }
    }
  }

  return awarded;
}

export async function runMonthlyAchievements(): Promise<void> {
  const agents = await db.select({ id: agentsTable.id })
    .from(agentsTable)
    .where(eq(agentsTable.status, "ACTIVE"));

  let awarded = 0;
  for (const agent of agents) {
    try {
      const badges = await checkAchievements(agent.id);
      awarded += badges.length;
    } catch (err) {
      console.error(`[AchievementChecker] agent ${agent.id} failed:`, err);
    }
  }
  console.info(`[AchievementChecker] awarded ${awarded} badges to ${agents.length} agents`);
}
