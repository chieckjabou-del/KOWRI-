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
}                                  from "@workspace/db";
import { eq, and, sql, ne }        from "drizzle-orm";
import { generateId }              from "./id";
import { processTransfer }         from "./walletService";
import { logIncident }             from "./incidentStore";

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
