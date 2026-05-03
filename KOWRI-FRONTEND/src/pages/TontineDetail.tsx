import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Loader2, ChevronDown, ChevronUp, Tag, Gavel, ShoppingBag,
  Brain, AlertCircle, TrendingUp, Shield, Zap, X, Crown,
  PiggyBank, CheckCircle2,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { TontineMemberRow } from "@/components/TontineMemberRow";
import { TYPE_META, STATUS_META, FREQ_LABELS } from "@/lib/tontineTypes";

interface Props { params: { id: string } }

// ── Helpers ───────────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
  const meta = TYPE_META[type] ?? { label: type, colorClass: "bg-gray-100 text-gray-700", icon: "●" };
  const isHybrid = type === "hybrid";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${isHybrid ? "" : meta.colorClass}`}
      style={isHybrid ? { background: "linear-gradient(to right, #dcfce7, #dbeafe)", color: "#166534" } : undefined}
    >
      {meta.icon} {meta.label}
    </span>
  );
}

function ProgressRing({ current, total, size = 96 }: { current: number; total: number; size?: number }) {
  const r    = (size - 10) / 2;
  const circ = 2 * Math.PI * r;
  const pct  = total > 0 ? Math.min(1, current / total) : 0;
  return (
    <div className="relative flex-shrink-0">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E5E7EB" strokeWidth={7} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1A6B32" strokeWidth={7}
          strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-black text-gray-900 leading-none">{current}</span>
        <span className="text-xs text-gray-500">/ {total}</span>
      </div>
    </div>
  );
}

function SectionCard({ title, icon: Icon, children, defaultOpen = true }: {
  title: string; icon?: React.ElementType; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3.5"
      >
        <div className="flex items-center gap-2">
          {Icon && <Icon size={16} className="text-gray-500" />}
          <span className="font-semibold text-gray-900 text-sm">{title}</span>
        </div>
        {open ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
      </button>
      {open && <div className="border-t border-gray-50 px-4 pb-4 pt-3">{children}</div>}
    </div>
  );
}

// ── Modal: Sell Position ──────────────────────────────────────────────────────

function SellModal({ tontineId, userId, onClose }: { tontineId: string; userId: string; onClose: () => void }) {
  const { token } = useAuth();
  const qc = useQueryClient();
  const [askPrice, setAskPrice] = useState("");
  const [error, setError] = useState("");

  const sellMut = useMutation({
    mutationFn: () => apiFetch<any>(`/community/tontines/${tontineId}/positions/list`, token, {
      method: "POST",
      body: JSON.stringify({ sellerId: userId, askPrice: parseFloat(askPrice) }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tontine-positions", tontineId] }); onClose(); },
    onError: (e: any) => setError(e.message ?? "Erreur"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 pb-8">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-gray-900">Vendre ma position</h3>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">
            <X size={18} className="text-gray-500" />
          </button>
        </div>
        {error && <div className="mb-3 text-sm text-red-700 bg-red-50 px-3 py-2 rounded-xl">{error}</div>}
        <div className="mb-5">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Prix demandé (XOF)</label>
          <input type="number" inputMode="numeric" value={askPrice} onChange={e => setAskPrice(e.target.value)}
            placeholder="Ex: 50 000"
            className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none"
            style={{ minHeight: 48 }} />
        </div>
        <button
          onClick={() => sellMut.mutate()}
          disabled={!askPrice || sellMut.isPending}
          className="w-full py-3.5 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-60"
          style={{ background: "#1A6B32", minHeight: 48 }}
        >
          {sellMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
          Mettre en vente
        </button>
      </div>
    </div>
  );
}

// ── Modal: Bid ────────────────────────────────────────────────────────────────

function BidModal({ tontineId, userId, onClose }: { tontineId: string; userId: string; onClose: () => void }) {
  const { token } = useAuth();
  const qc = useQueryClient();
  const [bidAmount, setBidAmount] = useState("");
  const [desiredPosition, setDesiredPosition] = useState("1");
  const [error, setError] = useState("");

  const bidMut = useMutation({
    mutationFn: () => apiFetch<any>(`/community/tontines/${tontineId}/bids`, token, {
      method: "POST",
      body: JSON.stringify({ userId, bidAmount: parseFloat(bidAmount), desiredPosition: parseInt(desiredPosition) }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tontine-bids", tontineId] }); onClose(); },
    onError: (e: any) => setError(e.message ?? "Erreur"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 pb-8">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-gray-900">Enchérir</h3>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">
            <X size={18} className="text-gray-500" />
          </button>
        </div>
        {error && <div className="mb-3 text-sm text-red-700 bg-red-50 px-3 py-2 rounded-xl">{error}</div>}
        <div className="space-y-4 mb-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Montant de l'enchère (XOF)</label>
            <input type="number" inputMode="numeric" value={bidAmount} onChange={e => setBidAmount(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none" style={{ minHeight: 48 }} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Position souhaitée</label>
            <input type="number" inputMode="numeric" min={1} value={desiredPosition} onChange={e => setDesiredPosition(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none" style={{ minHeight: 48 }} />
          </div>
        </div>
        <button
          onClick={() => bidMut.mutate()}
          disabled={!bidAmount || bidMut.isPending}
          className="w-full py-3.5 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-60"
          style={{ background: "#1A6B32", minHeight: 48 }}
        >
          {bidMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
          Placer l'enchère
        </button>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function TontineDetail({ params }: Props) {
  const { id }             = params;
  const { token, user }    = useAuth();
  const [, navigate]       = useLocation();
  const qc                 = useQueryClient();
  const [showSell, setShowSell]         = useState(false);
  const [showBid, setShowBid]           = useState(false);
  const [error, setError]               = useState("");

  /* Auto-save payout state */
  const [autoSave, setAutoSave]         = useState(false);
  const [autoSaveDays, setAutoSaveDays] = useState(90);
  const [saveError, setSaveError]       = useState("");
  const [saveSuccess, setSaveSuccess]   = useState(false);

  // ── Core data ──────────────────────────────────────────────────────────────
  const tontineQ = useQuery({
    queryKey: ["tontine", id],
    queryFn:  () => apiFetch<any>(`/tontines/${id}`, token),
    enabled:  !!id,
  });
  const membersQ = useQuery({
    queryKey: ["tontine-members", id],
    queryFn:  () => apiFetch<any>(`/tontines/${id}/members`, token),
    enabled:  !!id,
  });

  /* Wallet (needed for savings) */
  const walletQ = useQuery({
    queryKey: ["wallets", user?.id],
    queryFn:  () => apiFetch<any>(`/wallets?userId=${user?.id}&limit=1`, token),
    enabled:  !!user?.id,
    staleTime: 30_000,
  });
  const myWallet = walletQ.data?.wallets?.[0] ?? null;

  const tontine = tontineQ.data?.tontine ?? tontineQ.data;
  const members: any[] = membersQ.data?.members ?? [];
  const tType = tontine?.tontineType ?? "classic";
  const isAdmin = tontine?.adminUserId === user?.id;

  // ── Type-specific queries ──────────────────────────────────────────────────
  const goalsQ = useQuery({
    queryKey: ["tontine-goals", id],
    queryFn:  () => apiFetch<any>(`/community/tontines/${id}/goals`, token),
    enabled:  !!id && tType === "project",
  });
  const yieldQ = useQuery({
    queryKey: ["tontine-yield", id],
    queryFn:  () => apiFetch<any>(`/community/tontines/${id}/yield-summary`, token),
    enabled:  !!id && tType === "yield",
  });
  const growthQ = useQuery({
    queryKey: ["tontine-growth", id],
    queryFn:  () => apiFetch<any>(`/community/tontines/${id}/growth-projection`, token),
    enabled:  !!id && tType === "growth",
  });
  const hybridQ = useQuery({
    queryKey: ["tontine-hybrid", id],
    queryFn:  () => apiFetch<any>(`/community/tontines/${id}/hybrid-summary`, token),
    enabled:  !!id && tType === "hybrid",
  });
  const strategyQ = useQuery({
    queryKey: ["tontine-strategy", id],
    queryFn:  () => apiFetch<any>(`/community/tontines/${id}/strategy/targets`, token),
    enabled:  !!id && (tType === "strategy" || tontine?.strategyMode),
  });
  const aiQ = useQuery({
    queryKey: ["tontine-ai", id],
    queryFn:  () => apiFetch<any>(`/community/tontines/${id}/ai-assessment`, token),
    enabled:  !!id,
    retry:    false,
  });
  const positionsQ = useQuery({
    queryKey: ["tontine-positions", id],
    queryFn:  () => apiFetch<any>(`/community/tontines/${id}/positions/market`, token),
    enabled:  !!id,
  });
  const bidsQ = useQuery({
    queryKey: ["tontine-bids", id],
    queryFn:  () => apiFetch<any>(`/community/tontines/${id}/bids`, token),
    enabled:  !!id,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const contributeMut = useMutation({
    mutationFn: () => apiFetch<any>(`/community/tontines/${id}/collect`, token, {
      method: "POST",
      headers: { "Idempotency-Key": generateIdempotencyKey() } as any,
      body: JSON.stringify({ userId: user?.id }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tontine", id] });
      qc.invalidateQueries({ queryKey: ["tontines", user?.id] });
      setError("");
    },
    onError: (e: any) => setError(e.message ?? "Erreur lors de la cotisation"),
  });

  const applyAiMut = useMutation({
    mutationFn: () => apiFetch<any>(`/community/tontines/${id}/apply-ai-order`, token, {
      method: "POST",
      body: JSON.stringify({ adminOverride: false }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tontine-ai", id] });
      qc.invalidateQueries({ queryKey: ["tontine-members", id] });
    },
    onError: (e: any) => setError(e.message ?? "Erreur AI"),
  });

  const releaseGoalMut = useMutation({
    mutationFn: (goalId: string) => apiFetch<any>(`/community/tontines/${id}/goals/${goalId}/release`, token, {
      method: "POST",
      body: JSON.stringify({ adminUserId: user?.id }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tontine-goals", id] }),
    onError: (e: any) => setError(e.message ?? "Erreur"),
  });

  const saveMut = useMutation({
    mutationFn: (amount: number) => {
      if (!myWallet) throw new Error("Wallet introuvable");
      const name = `Payout tontine — ${tontine?.name ?? id}`;
      return apiFetch<any>("/savings/plans", token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() } as any,
        body: JSON.stringify({
          userId: user?.id,
          walletId: myWallet.id,
          name,
          amount,
          currency: "XOF",
          termDays: autoSaveDays,
        }),
      });
    },
    onSuccess: () => {
      setSaveSuccess(true);
      setSaveError("");
      qc.invalidateQueries({ queryKey: ["wallets", user?.id] });
    },
    onError: (e: any) => setSaveError(e.message ?? "Erreur épargne"),
  });

  // ── Loading ────────────────────────────────────────────────────────────────
  const statusMeta = STATUS_META[tontine?.status ?? "pending"] ?? STATUS_META["pending"];
  const currentRound = tontine?.currentRound ?? 0;
  const totalRounds  = tontine?.totalRounds  ?? tontine?.maxMembers ?? 1;
  const nextDate     = tontine?.nextPayoutDate
    ? new Date(tontine.nextPayoutDate).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "long" })
    : null;

  const myMembership = members.find(m => m.userId === user?.id);
  const isMember     = !!myMembership;
  const aiData       = aiQ.data;
  const hasAi        = !!aiData?.rankedMembers?.length;

  return (
    <div className="min-h-screen pb-20" style={{ background: "#FAFAF8" }}>
      <TopBar
        showBack
        onBack={() => navigate("/tontines")}
        title={!tontineQ.isLoading && !tontine ? "Tontine introuvable" : undefined}
      />
      {tontineQ.isLoading ? (
        <div className="flex items-center justify-center pt-20">
          <Loader2 size={32} className="animate-spin text-gray-300" />
        </div>
      ) : !tontine ? (
        <div className="px-4 pt-10 text-center text-gray-500">Tontine introuvable</div>
      ) : (
        <>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="px-4 pt-4 pb-3 max-w-lg mx-auto">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              <TypeBadge type={tType} />
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${statusMeta.colorClass}`}>{statusMeta.label}</span>
            </div>
            <h1 className="text-xl font-black text-gray-900 leading-tight">{tontine.name}</h1>
          </div>
        </div>

        {/* AI Banner */}
        {hasAi && (
          <div className="mb-3 px-3 py-2 rounded-xl flex items-center gap-2 text-xs font-medium"
            style={{ background: "#F0FDF4", color: "#1A6B32", border: "1px solid #BBF7D0" }}>
            <Brain size={14} />
            Évaluation IA disponible — {aiData.rankedMembers.length} membres scorés
          </div>
        )}
      </div>

      <main className="px-4 pb-4 max-w-lg mx-auto space-y-3">
        {error && (
          <div className="px-4 py-3 rounded-xl text-sm flex items-center gap-2 text-red-700 bg-red-50">
            <AlertCircle size={15} /> {error}
            <button onClick={() => setError("")} className="ml-auto"><X size={14} /></button>
          </div>
        )}

        {/* ── Section 1: Progress ─────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-4">
            <ProgressRing current={currentRound} total={totalRounds} size={96} />
            <div className="flex-1">
              <p className="text-xs text-gray-500 mb-0.5">Progression</p>
              <p className="text-lg font-black text-gray-900">Cycle {currentRound} / {totalRounds}</p>
              {nextDate && (
                <p className="text-xs text-gray-500 mt-1">Prochain événement : <span className="font-semibold text-gray-700">{nextDate}</span></p>
              )}
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-gray-500">Cagnotte :</span>
                <span className="text-sm font-bold" style={{ color: "#1A6B32" }}>
                  {formatXOF(tontine.contributionAmount)} / {FREQ_LABELS[tontine.frequency] ?? tontine.frequency}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Section 2: Members ──────────────────────────────────────────── */}
        <SectionCard title={`Membres (${members.length})`} icon={undefined} defaultOpen={members.length <= 8}>
          {membersQ.isLoading ? (
            <div className="flex items-center justify-center py-4"><Loader2 size={20} className="animate-spin text-gray-300" /></div>
          ) : members.length === 0 ? (
            <p className="text-sm text-gray-500 py-2">Aucun membre encore</p>
          ) : (
            <div className="space-y-1 -mx-1">
              {members.map((m: any) => (
                <TontineMemberRow key={m.id} member={m} currentRound={currentRound} currentUserId={user?.id} />
              ))}
            </div>
          )}
        </SectionCard>

        {/* ── Section 3: Actions ──────────────────────────────────────────── */}
        <SectionCard title="Actions" defaultOpen>
          <div className="space-y-3">
            {/* Cotiser */}
            {isMember && tontine.status === "active" && (
              <button
                onClick={() => contributeMut.mutate()}
                disabled={contributeMut.isPending}
                className="w-full py-3.5 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-60"
                style={{ background: "#1A6B32", minHeight: 48 }}
              >
                {contributeMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
                Cotiser maintenant
              </button>
            )}

            {/* ── Auto-save payout ─────────────────────────────────── */}
            {isMember && tontine.status === "active" && (
              <div className="rounded-xl border border-gray-100 overflow-hidden" style={{ background: "#FAFAF8" }}>
                {/* Toggle row */}
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <PiggyBank size={16} style={{ color: "#1A6B32" }} />
                    <div>
                      <p className="text-sm font-semibold text-gray-900">Épargner mon payout</p>
                      <p className="text-xs text-gray-500">Envoyer vers un plan d'épargne</p>
                    </div>
                  </div>
                  <button
                    onClick={() => { setAutoSave(a => !a); setSaveError(""); setSaveSuccess(false); }}
                    className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                    style={{ background: autoSave ? "#1A6B32" : "#D1D5DB" }}
                  >
                    <span
                      className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform"
                      style={{ transform: autoSave ? "translateX(20px)" : "translateX(0)" }}
                    />
                  </button>
                </div>

                {/* Duration selector — only when enabled */}
                {autoSave && (
                  <div className="px-4 pb-4 space-y-3 border-t border-gray-100 pt-3">
                    <p className="text-xs font-medium text-gray-600">Durée de l'épargne</p>
                    <div className="grid grid-cols-4 gap-2">
                      {[30, 60, 90, 180].map(d => (
                        <button
                          key={d}
                          onClick={() => setAutoSaveDays(d)}
                          className="py-2.5 rounded-xl text-xs font-semibold border transition-all"
                          style={{
                            background: autoSaveDays === d ? "#F0FDF4" : "white",
                            borderColor: autoSaveDays === d ? "#1A6B32" : "#E5E7EB",
                            color: autoSaveDays === d ? "#1A6B32" : "#6B7280",
                            minHeight: 40,
                          }}
                        >
                          {d}j
                        </button>
                      ))}
                    </div>

                    {/* Info banner */}
                    <div className="rounded-xl px-3 py-2.5" style={{ background: "#F0FDF4", border: "1px solid #BBF7D0" }}>
                      <p className="text-xs text-green-800">
                        Quand vous recevez un payout, cliquez{" "}
                        <strong>Épargner ce payout</strong> pour le verrouiller {autoSaveDays} jours avec intérêts.
                      </p>
                    </div>

                    {/* "Épargner ce payout" action — only visible when it's user's payout turn */}
                    {(() => {
                      const myMember = members.find(m => m.userId === user?.id);
                      const isMyTurn = myMember && (myMember.payoutOrder === currentRound);
                      const payoutAmt = Number(tontine.contributionAmount ?? 0) * members.length;
                      if (!isMyTurn || payoutAmt <= 0) return null;
                      if (saveSuccess) {
                        return (
                          <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl" style={{ background: "#F0FDF4", border: "1px solid #BBF7D0" }}>
                            <CheckCircle2 size={16} style={{ color: "#1A6B32" }} />
                            <p className="text-sm font-semibold text-green-800">Payout épargné !</p>
                          </div>
                        );
                      }
                      return (
                        <div className="space-y-2">
                          <div className="rounded-xl px-3 py-2 border border-yellow-200" style={{ background: "#FFFBEB" }}>
                            <p className="text-xs font-semibold text-yellow-800">
                              🎉 C'est votre tour ! Payout estimé : {formatXOF(payoutAmt)}
                            </p>
                          </div>
                          {saveError ? (
                            <div className="px-3 py-2 rounded-xl text-xs" style={{ background: "#FEF2F2", color: "#DC2626" }}>
                              {saveError}
                            </div>
                          ) : null}
                          <button
                            onClick={() => saveMut.mutate(payoutAmt)}
                            disabled={saveMut.isPending}
                            className="w-full py-3 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-60"
                            style={{ background: "#1A6B32", minHeight: 44 }}
                          >
                            {saveMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <PiggyBank size={14} />}
                            Épargner ce payout ({formatXOF(payoutAmt)})
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* Project: goal progress */}
            {tType === "project" && goalsQ.data?.map((goal: any) => (
              <div key={goal.id} className="rounded-xl border border-gray-100 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-900">{goal.goalDescription ?? "Objectif"}</span>
                  <span className="text-xs text-gray-500">{goal.vendorName}</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2 mb-2">
                  <div className="h-2 rounded-full" style={{ background: "#1A6B32", width: `${Math.min(100, (Number(goal.currentAmount) / Number(goal.goalAmount)) * 100)}%` }} />
                </div>
                <div className="flex justify-between text-xs text-gray-500 mb-2">
                  <span>{formatXOF(goal.currentAmount)}</span>
                  <span>{formatXOF(goal.goalAmount)}</span>
                </div>
                {goal.status === "open" && isAdmin && Number(goal.currentAmount) >= Number(goal.goalAmount) && (
                  <button
                    onClick={() => releaseGoalMut.mutate(goal.id)}
                    disabled={releaseGoalMut.isPending}
                    className="w-full py-2 rounded-xl text-sm font-bold text-white"
                    style={{ background: "#1A6B32" }}
                  >
                    Débloquer les fonds
                  </button>
                )}
              </div>
            ))}

            {/* Type-specific summary — single slot ternary to keep stable child count */}
            {tType === "yield" ? (
              yieldQ.data ? (
                <div className="rounded-xl p-3 space-y-1.5" style={{ background: "#FFF7ED", border: "1px solid #FED7AA" }}>
                  <p className="text-xs font-bold text-orange-800 flex items-center gap-1"><TrendingUp size={12} /> Résumé rendement</p>
                  {[
                    { label: "Taux rendement", value: `${tontine.yieldRate ?? 0}% / an` },
                    { label: "Pool de rendement", value: formatXOF(tontine.yieldPoolBalance ?? 0) },
                    { label: "Yield dû (moi)", value: formatXOF(myMembership?.yieldOwed ?? 0) },
                    { label: "Yield payé (moi)", value: formatXOF(myMembership?.yieldPaid ?? 0) },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex justify-between text-xs">
                      <span className="text-orange-700">{label}</span>
                      <span className="font-semibold text-orange-900">{value}</span>
                    </div>
                  ))}
                </div>
              ) : null
            ) : tType === "growth" ? (
              growthQ.data ? (
                <div className="rounded-xl p-3" style={{ background: "#F7FEE7", border: "1px solid #D9F99D" }}>
                  <p className="text-xs font-bold text-lime-800 flex items-center gap-1 mb-2"><TrendingUp size={12} /> Projection de croissance</p>
                  <div className="grid grid-cols-2 gap-2">
                    {(growthQ.data.projection ?? []).slice(0, 4).map((p: any) => (
                      <div key={p.cycle} className="bg-white rounded-lg p-2 text-center">
                        <p className="text-xs text-gray-500">Cycle {p.cycle}</p>
                        <p className="text-sm font-bold text-lime-800">{formatXOF(p.amount)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null
            ) : tType === "hybrid" ? (
              hybridQ.data ? (
                <div className="rounded-xl p-3" style={{ background: "#F0FDF4", border: "1px solid #BBF7D0" }}>
                  <p className="text-xs font-bold text-green-800 flex items-center gap-1 mb-2"><Zap size={12} /> Répartition Hybride</p>
                  <div className="space-y-1.5">
                    {[
                      { label: "Rotation classique", pct: hybridQ.data.hybridConfig?.rotation_pct ?? 0,   color: "#1A6B32" },
                      { label: "Investissement",     pct: hybridQ.data.hybridConfig?.investment_pct ?? 0, color: "#2563EB" },
                      { label: "Réserve solidarité", pct: hybridQ.data.hybridConfig?.solidarity_pct ?? 0, color: "#7C3AED" },
                      { label: "Bonus rendement",    pct: hybridQ.data.hybridConfig?.yield_pct ?? 0,      color: "#EA580C" },
                    ].map(({ label, pct, color }) => (
                      <div key={label}>
                        <div className="flex justify-between text-xs mb-0.5">
                          <span className="text-gray-600">{label}</span>
                          <span className="font-semibold" style={{ color }}>{pct}%</span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-1.5">
                          <div className="h-1.5 rounded-full" style={{ background: color, width: `${pct}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  {hybridQ.data.solidarityReserveBalance > 0 ? (
                    <div className="mt-2 pt-2 border-t border-green-100">
                      <div className="flex items-center gap-1 text-xs text-purple-700">
                        <Shield size={11} />
                        Réserve solidarité : <span className="font-bold">{formatXOF(hybridQ.data.solidarityReserveBalance)}</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null
            ) : null}

            {/* Strategy targets — independent of tType, separate slot */}
            {tontine.strategyMode && strategyQ.data ? (
              <div className="rounded-xl p-3" style={{ background: "#F0FDFA", border: "1px solid #99F6E4" }}>
                <p className="text-xs font-bold text-teal-800 mb-2">Cibles Stratégiques</p>
                {(strategyQ.data.targets ?? []).map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between py-1.5 border-b border-teal-50 last:border-0">
                    <span className="text-xs text-gray-700 truncate flex-1">{t.merchant?.businessName ?? t.merchantId}</span>
                    <div className="text-right ml-2">
                      <p className="text-xs font-semibold text-teal-800">{formatXOF(t.allocatedAmount)}</p>
                      <p className="text-[10px] text-teal-600">Perf: {Number(t.performanceScore).toFixed(1)}%</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </SectionCard>

        {/* ── Section 4: AI Priority ──────────────────────────────────────── */}
        {hasAi && (
          <SectionCard title="Classement IA" icon={Brain} defaultOpen={false}>
            <div className="space-y-2 mb-3">
              {aiData.rankedMembers.slice(0, 8).map((m: any) => (
                <div key={m.userId} className="flex items-center gap-3 p-2 rounded-xl bg-gray-50">
                  <span className="text-xs font-black text-gray-400 w-5 text-center">#{m.rank}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-gray-900 truncate">{m.userId === user?.id ? "Moi" : `Membre ${m.rank}`}</p>
                    <p className="text-[10px] text-gray-500 truncate">{m.recommendation}</p>
                  </div>
                  <span className="text-xs font-bold flex-shrink-0" style={{ color: "#1A6B32" }}>{m.priorityScore}/100</span>
                </div>
              ))}
            </div>
            {isAdmin && tontine.status === "pending" && (
              <button
                onClick={() => applyAiMut.mutate()}
                disabled={applyAiMut.isPending}
                className="w-full py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 text-white disabled:opacity-60"
                style={{ background: "#1A6B32" }}
              >
                {applyAiMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}
                Appliquer l'ordre IA
              </button>
            )}
          </SectionCard>
        )}

        {/* ── Section 5: Secondary Market ─────────────────────────────────── */}
        <SectionCard title="Marché secondaire" icon={Tag} defaultOpen={false}>
          {isMember && tontine.status === "active" && (
            <button
              onClick={() => setShowSell(true)}
              className="w-full mb-3 py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 border"
              style={{ borderColor: "#1A6B32", color: "#1A6B32", minHeight: 44 }}
            >
              <ShoppingBag size={15} /> Vendre ma position
            </button>
          )}
          {positionsQ.isLoading ? (
            <div className="flex justify-center py-3"><Loader2 size={16} className="animate-spin text-gray-300" /></div>
          ) : (positionsQ.data?.listings ?? []).length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-2">Aucune position en vente</p>
          ) : (
            <div className="space-y-2">
              {(positionsQ.data?.listings ?? []).map((l: any) => (
                <div key={l.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                  <div>
                    <p className="text-xs font-semibold text-gray-900">Position #{l.payoutOrder}</p>
                    <p className="text-sm font-bold mt-0.5" style={{ color: "#1A6B32" }}>{formatXOF(l.askPrice)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* ── Section 6: Bids ─────────────────────────────────────────────── */}
        <SectionCard title="Enchères" icon={Gavel} defaultOpen={false}>
          {isMember && tontine.status === "active" && (
            <button
              onClick={() => setShowBid(true)}
              className="w-full mb-3 py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 text-white"
              style={{ background: "#1A6B32", minHeight: 44 }}
            >
              <Gavel size={15} /> Enchérir
            </button>
          )}
          {bidsQ.isLoading ? (
            <div className="flex justify-center py-3"><Loader2 size={16} className="animate-spin text-gray-300" /></div>
          ) : (bidsQ.data?.bids ?? []).length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-2">Aucune enchère active</p>
          ) : (
            <div className="space-y-2">
              {(bidsQ.data?.bids ?? [])
                .sort((a: any, b: any) => Number(b.bidAmount) - Number(a.bidAmount))
                .map((b: any, i: number) => (
                  <div key={b.id} className="flex items-center gap-3 p-2.5 rounded-xl bg-gray-50">
                    <span className="text-xs font-black text-gray-400">#{i + 1}</span>
                    <div className="flex-1">
                      <p className="text-xs text-gray-500">Position #{b.desiredPosition}</p>
                      <p className="text-sm font-bold" style={{ color: "#1A6B32" }}>{formatXOF(b.bidAmount)}</p>
                    </div>
                    {i === 0 && <Crown size={14} className="text-yellow-500" />}
                  </div>
                ))}
            </div>
          )}
        </SectionCard>
      </main>

      <BottomNav />

      {showSell && user && <SellModal tontineId={id} userId={user.id} onClose={() => setShowSell(false)} />}
      {showBid  && user && <BidModal  tontineId={id} userId={user.id} onClose={() => setShowBid(false)} />}
        </>
      )}
    </div>
  );
}
