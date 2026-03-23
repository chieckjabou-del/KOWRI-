import { useState }                             from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation }                           from "wouter";
import {
  AlertTriangle, CheckCircle2, ChevronRight, TrendingUp,
  Wallet, Loader2, User, ShieldCheck, BarChart3, ArrowRightLeft,
} from "lucide-react";
import { useAuth }                               from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { TopBar }                                from "@/components/TopBar";
import { BottomNav }                             from "@/components/BottomNav";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Agent {
  id: string; name: string; type: "AGENT" | "SUPER_AGENT" | "MASTER";
  zone: string; status: string; commissionTier: number; monthlyVolume: string;
}
interface AgentLiquidity {
  cashBalance: number; floatBalance: number;
  cashStatus: "OK" | "WARNING" | "CRITICAL";
  floatStatus: "OK" | "WARNING" | "CRITICAL";
  minCashThreshold: number; minFloatThreshold: number;
  monthlyVolume: number; commissionTier: number;
  activeAlerts: Alert[];
  suggestions: string[];
  nearestSuperAgent: { id: string; name: string; floatBalance: number } | null;
}
interface Alert {
  id: string; type: string; level: "WARNING" | "CRITICAL";
  message: string; suggestedAction: string | null; createdAt: string;
}
interface Commissions {
  totals: { earnedThisMonth: number; pending: number; paid: number; today: number };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_COLOR = {
  OK:       "bg-green-500",
  WARNING:  "bg-orange-400",
  CRITICAL: "bg-red-500",
};

const STATUS_LABEL = {
  OK:       "Bon",
  WARNING:  "Attention",
  CRITICAL: "Critique",
};

function LiquidityBar({
  label, balance, threshold, status,
}: { label: string; balance: number; threshold: number; status: "OK" | "WARNING" | "CRITICAL" }) {
  const pct = threshold > 0 ? Math.min(100, Math.round((balance / (threshold * 2)) * 100)) : 50;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-600 font-medium">{label}</span>
        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold text-white ${STATUS_COLOR[status]}`}>
          {STATUS_LABEL[status]}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${STATUS_COLOR[status]}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-sm font-semibold text-gray-900 w-28 text-right">{formatXOF(balance)}</span>
      </div>
      <div className="text-xs text-gray-400">Seuil min : {formatXOF(threshold)}</div>
    </div>
  );
}

function TierBadge({ tier }: { tier: number }) {
  const colors = ["", "bg-gray-100 text-gray-700", "bg-blue-100 text-blue-700", "bg-amber-100 text-amber-700"];
  const labels = ["", "Niveau 1", "Niveau 2 +10%", "Niveau 3 +20%"];
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${colors[tier] ?? colors[1]}`}>
      {labels[tier] ?? `Niveau ${tier}`}
    </span>
  );
}

function AgentTypeBadge({ type }: { type: string }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    AGENT:       { label: "Agent",        cls: "bg-green-100 text-green-800" },
    SUPER_AGENT: { label: "Super Agent",  cls: "bg-purple-100 text-purple-800" },
    MASTER:      { label: "Master",       cls: "bg-amber-100 text-amber-800" },
  };
  const { label, cls } = cfg[type] ?? { label: type, cls: "bg-gray-100 text-gray-700" };
  return <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${cls}`}>{label}</span>;
}

// ── Cash Declaration Modal ─────────────────────────────────────────────────────

function CashModal({
  agentId, token, onClose,
}: { agentId: string; token: string | null; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const [err,    setErr]    = useState("");
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: () =>
      apiFetch(`/agents/${agentId}/cash-update`, token, {
        method: "POST",
        body:   JSON.stringify({ cashBalance: Number(amount) }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-liquidity", agentId] });
      onClose();
    },
    onError: (e: any) => setErr(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4">
      <div className="w-full max-w-md bg-white rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-bold text-gray-900">Déclarer mon cash</h2>
        <p className="text-sm text-gray-500">Entrez le montant de cash physique que vous avez actuellement.</p>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Ex : 250000"
          className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none"
        />
        {err && <p className="text-red-500 text-sm">{err}</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-gray-200 text-gray-700 font-semibold text-sm">
            Annuler
          </button>
          <button
            onClick={() => mut.mutate()}
            disabled={!amount || mut.isPending}
            className="flex-1 py-3 rounded-xl bg-[#1A6B32] text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {mut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
            Confirmer
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Float Request Modal ───────────────────────────────────────────────────────

function FloatModal({
  agentId, token, nearestSuperAgent, onClose,
}: {
  agentId: string; token: string | null;
  nearestSuperAgent: AgentLiquidity["nearestSuperAgent"];
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [err,    setErr]    = useState("");
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: () =>
      apiFetch(`/agents/${agentId}/liquidity-transfer`, token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() } as any,
        body:   JSON.stringify({
          toAgentId: nearestSuperAgent?.id,
          amount:    Number(amount),
          type:      "FLOAT",
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-liquidity", agentId] });
      onClose();
    },
    onError: (e: any) => setErr(e.message),
  });

  if (!nearestSuperAgent) {
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4">
        <div className="w-full max-w-md bg-white rounded-2xl p-6 space-y-4">
          <h2 className="text-lg font-bold text-gray-900">Demander du float</h2>
          <p className="text-sm text-gray-500">Aucun Super Agent disponible dans votre zone pour l'instant.</p>
          <button onClick={onClose} className="w-full py-3 rounded-xl bg-gray-100 text-gray-700 font-semibold text-sm">Fermer</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4">
      <div className="w-full max-w-md bg-white rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-bold text-gray-900">Demander du float</h2>
        <div className="p-3 bg-green-50 rounded-xl text-sm text-green-800">
          Super Agent : <strong>{nearestSuperAgent.name}</strong> — Float disponible : {formatXOF(nearestSuperAgent.floatBalance)}
        </div>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Montant à demander (XOF)"
          className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none"
        />
        {err && <p className="text-red-500 text-sm">{err}</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-gray-200 text-gray-700 font-semibold text-sm">Annuler</button>
          <button
            onClick={() => mut.mutate()}
            disabled={!amount || mut.isPending}
            className="flex-1 py-3 rounded-xl bg-[#1A6B32] text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {mut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
            Envoyer
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AgentPage() {
  const { token, user }       = useAuth();
  const [, navigate]          = useLocation();
  const [showCash,  setShowCash]  = useState(false);
  const [showFloat, setShowFloat] = useState(false);
  const [showComm,  setShowComm]  = useState(false);
  const qc = useQueryClient();

  // Fetch agent for current user
  const agentQ = useQuery<{ agents: Agent[] }>({
    queryKey: ["agent", user?.id],
    queryFn: () => apiFetch(`/agents?userId=${user?.id}&limit=1`, token),
    enabled:  !!user?.id,
    staleTime: 30_000,
  });

  const agent: Agent | null = agentQ.data?.agents?.[0] ?? null;

  const liqQ = useQuery<AgentLiquidity>({
    queryKey: ["agent-liquidity", agent?.id],
    queryFn: () => apiFetch(`/agents/${agent!.id}/liquidity`, token),
    enabled:  !!agent?.id,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const commQ = useQuery<Commissions>({
    queryKey: ["agent-commissions", agent?.id],
    queryFn: () => apiFetch(`/agents/${agent!.id}/commissions?limit=1`, token),
    enabled:  !!agent?.id,
    staleTime: 30_000,
  });

  const resolveAlert = useMutation({
    mutationFn: (alertId: string) =>
      apiFetch(`/agents/${agent!.id}/alerts/${alertId}/resolve`, token, { method: "PATCH" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent-liquidity", agent?.id] }),
  });

  // ── Loading state ──────────────────────────────────────────────────────────
  if (agentQ.isLoading) {
    return (
      <div className="min-h-screen bg-[#FAFAF8] flex flex-col">
        <TopBar title="Espace Agent" />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={32} className="animate-spin text-[#1A6B32]" />
        </div>
        <BottomNav />
      </div>
    );
  }

  // ── No agent account ───────────────────────────────────────────────────────
  if (!agent) {
    return (
      <div className="min-h-screen bg-[#FAFAF8] flex flex-col">
        <TopBar title="Espace Agent" />
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-6">
          <div className="w-20 h-20 rounded-full bg-gray-100 flex items-center justify-center">
            <User size={36} className="text-gray-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">Vous n'êtes pas encore agent</h2>
            <p className="text-gray-500 text-sm leading-relaxed">
              Pour devenir agent KOWRI et accéder au réseau de liquidité, contactez votre Super Agent ou notre équipe.
            </p>
          </div>
          <button
            onClick={() => navigate("/dashboard")}
            className="px-6 py-3 rounded-xl bg-[#1A6B32] text-white font-semibold text-sm"
          >
            Retour au tableau de bord
          </button>
        </div>
        <BottomNav />
      </div>
    );
  }

  const liq  = liqQ.data;
  const comm = commQ.data;

  // Tier progress towards next tier
  const tierVolume   = liq?.monthlyVolume ?? 0;
  const tierTarget   = liq?.commissionTier === 1 ? 5_000_000 : 20_000_000;
  const tierProgress = liq?.commissionTier === 3 ? 100 : Math.min(100, Math.round((tierVolume / tierTarget) * 100));

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex flex-col pb-24">
      <TopBar title="Espace Agent" />

      {showCash  && <CashModal  agentId={agent.id} token={token} onClose={() => setShowCash(false)} />}
      {showFloat && <FloatModal agentId={agent.id} token={token} nearestSuperAgent={liq?.nearestSuperAgent ?? null} onClose={() => setShowFloat(false)} />}

      <div className="px-4 pt-4 space-y-4">

        {/* ── Header: Agent Name + Type ── */}
        <div className="bg-[#1A6B32] rounded-2xl px-5 py-5 text-white">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-green-200 text-xs font-medium mb-1">Compte Agent</p>
              <h1 className="text-xl font-bold">{agent.name}</h1>
              <p className="text-green-200 text-sm mt-0.5">Zone : {agent.zone}</p>
            </div>
            <AgentTypeBadge type={agent.type} />
          </div>
          <div className="flex items-center gap-2 mt-3">
            <div className={`w-2 h-2 rounded-full ${agent.status === "ACTIVE" ? "bg-green-300" : "bg-red-400"}`} />
            <span className="text-green-100 text-xs">{agent.status === "ACTIVE" ? "Actif" : agent.status}</span>
          </div>
        </div>

        {/* ── Card 1: Liquidity Status ── */}
        <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <Wallet size={18} className="text-[#1A6B32]" />
            <h2 className="font-bold text-gray-900">Liquidité</h2>
          </div>
          {liqQ.isLoading ? (
            <div className="flex justify-center py-4"><Loader2 size={20} className="animate-spin text-gray-400" /></div>
          ) : liq ? (
            <div className="space-y-4">
              <LiquidityBar
                label="Cash physique"
                balance={liq.cashBalance}
                threshold={liq.minCashThreshold}
                status={liq.cashStatus}
              />
              <LiquidityBar
                label="Float digital"
                balance={liq.floatBalance}
                threshold={liq.minFloatThreshold}
                status={liq.floatStatus}
              />
            </div>
          ) : (
            <p className="text-sm text-gray-400 text-center py-2">Données indisponibles</p>
          )}
        </div>

        {/* ── Card 2: Active Alerts ── */}
        {(liq?.activeAlerts?.length ?? 0) > 0 && (
          <div className="bg-white rounded-2xl p-5 shadow-sm space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-orange-500" />
              <h2 className="font-bold text-gray-900">Alertes actives</h2>
              <span className="ml-auto bg-red-100 text-red-600 text-xs font-bold px-2 py-0.5 rounded-full">
                {liq!.activeAlerts.length}
              </span>
            </div>
            <div className="space-y-2">
              {liq!.activeAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`p-3 rounded-xl border-l-4 ${alert.level === "CRITICAL" ? "border-red-500 bg-red-50" : "border-orange-400 bg-orange-50"}`}
                >
                  <p className={`text-sm font-semibold ${alert.level === "CRITICAL" ? "text-red-700" : "text-orange-700"}`}>
                    {alert.message}
                  </p>
                  {alert.suggestedAction && (
                    <p className="text-xs text-gray-600 mt-1">{alert.suggestedAction}</p>
                  )}
                  <button
                    onClick={() => resolveAlert.mutate(alert.id)}
                    disabled={resolveAlert.isPending}
                    className="mt-2 flex items-center gap-1 text-xs text-[#1A6B32] font-semibold"
                  >
                    <CheckCircle2 size={12} /> Résoudre
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Card 3: Today's Activity ── */}
        <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <BarChart3 size={18} className="text-[#1A6B32]" />
            <h2 className="font-bold text-gray-900">Activité du mois</h2>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs text-gray-500 mb-1">Commissions aujourd'hui</p>
              <p className="text-base font-bold text-gray-900">{formatXOF(comm?.totals.today ?? 0)}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs text-gray-500 mb-1">Volume mensuel</p>
              <p className="text-base font-bold text-gray-900">{formatXOF(liq?.monthlyVolume ?? 0)}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs text-gray-500 mb-1">Ce mois</p>
              <p className="text-base font-bold text-green-700">{formatXOF(comm?.totals.earnedThisMonth ?? 0)}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs text-gray-500 mb-1">En attente</p>
              <p className="text-base font-bold text-orange-600">{formatXOF(comm?.totals.pending ?? 0)}</p>
            </div>
          </div>
          {/* Tier progress */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600 font-medium">Palier de commission</span>
              <TierBadge tier={liq?.commissionTier ?? 1} />
            </div>
            {(liq?.commissionTier ?? 1) < 3 && (
              <>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-[#1A6B32] rounded-full transition-all" style={{ width: `${tierProgress}%` }} />
                </div>
                <p className="text-xs text-gray-400">
                  {formatXOF(tierVolume)} / {formatXOF(tierTarget)} pour passer au palier {(liq?.commissionTier ?? 1) + 1}
                </p>
              </>
            )}
          </div>
        </div>

        {/* ── Card 4: Quick Actions ── */}
        <div className="bg-white rounded-2xl p-5 shadow-sm space-y-2">
          <div className="flex items-center gap-2 mb-3">
            <ShieldCheck size={18} className="text-[#1A6B32]" />
            <h2 className="font-bold text-gray-900">Actions rapides</h2>
          </div>

          <button
            onClick={() => setShowCash(true)}
            className="w-full flex items-center justify-between py-3.5 px-4 rounded-xl bg-gray-50 hover:bg-gray-100 transition"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center">
                <Wallet size={16} className="text-[#1A6B32]" />
              </div>
              <span className="text-sm font-semibold text-gray-900">Déclarer mon cash</span>
            </div>
            <ChevronRight size={16} className="text-gray-400" />
          </button>

          <button
            onClick={() => setShowFloat(true)}
            className="w-full flex items-center justify-between py-3.5 px-4 rounded-xl bg-gray-50 hover:bg-gray-100 transition"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center">
                <ArrowRightLeft size={16} className="text-blue-600" />
              </div>
              <span className="text-sm font-semibold text-gray-900">Demander du float</span>
            </div>
            <ChevronRight size={16} className="text-gray-400" />
          </button>

          <button
            onClick={() => setShowComm(!showComm)}
            className="w-full flex items-center justify-between py-3.5 px-4 rounded-xl bg-gray-50 hover:bg-gray-100 transition"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center">
                <TrendingUp size={16} className="text-amber-600" />
              </div>
              <span className="text-sm font-semibold text-gray-900">Mes commissions</span>
            </div>
            <ChevronRight size={16} className="text-gray-400" />
          </button>
        </div>

        {/* Commission detail when expanded */}
        {showComm && (
          <div className="bg-white rounded-2xl p-5 shadow-sm space-y-3">
            <h3 className="font-bold text-gray-900 text-sm">Résumé des commissions</h3>
            <div className="divide-y divide-gray-100">
              <div className="flex justify-between py-2.5 text-sm">
                <span className="text-gray-500">Aujourd'hui</span>
                <span className="font-semibold text-gray-900">{formatXOF(comm?.totals.today ?? 0)}</span>
              </div>
              <div className="flex justify-between py-2.5 text-sm">
                <span className="text-gray-500">Ce mois</span>
                <span className="font-semibold text-green-700">{formatXOF(comm?.totals.earnedThisMonth ?? 0)}</span>
              </div>
              <div className="flex justify-between py-2.5 text-sm">
                <span className="text-gray-500">En attente</span>
                <span className="font-semibold text-orange-600">{formatXOF(comm?.totals.pending ?? 0)}</span>
              </div>
              <div className="flex justify-between py-2.5 text-sm">
                <span className="text-gray-500">Payées</span>
                <span className="font-semibold text-gray-900">{formatXOF(comm?.totals.paid ?? 0)}</span>
              </div>
            </div>
          </div>
        )}

      </div>
      <BottomNav />
    </div>
  );
}
