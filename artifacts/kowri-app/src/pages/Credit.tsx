import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, TrendingUp, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

/* ─── Tier config ─────────────────────────────────────────────────────────── */
const TIERS: Record<string, { label: string; bg: string; color: string; ring: string }> = {
  bronze:   { label: "BRONZE",   bg: "#FEF3C7", color: "#92400E", ring: "#D97706" },
  silver:   { label: "ARGENT",   bg: "#EFF6FF", color: "#1D4ED8", ring: "#3B82F6" },
  gold:     { label: "OR",       bg: "#FFFBEB", color: "#B45309", ring: "#F59E0B" },
  platinum: { label: "PLATINE",  bg: "#F5F3FF", color: "#6D28D9", ring: "#8B5CF6" },
};

const FACTORS = [
  { key: "transactionVolume",    label: "Volume de transactions", max: 30 },
  { key: "tontineParticipation", label: "Fiabilité tontine",       max: 25 },
  { key: "paymentHistory",       label: "Remboursements",           max: 20 },
  { key: "networkScore",         label: "Engagement communauté",   max: 15 },
  { key: "savingsRegularity",    label: "Discipline d'épargne",    max: 10 },
];

const TERM_OPTIONS = [30, 60, 90];

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
function pct(value: number): number {
  // factors come in as 0-1 floats from the engine
  return Math.min(Math.round(value * 100), 100);
}

function monthlyPayment(amount: number, ratePct: number, termDays: number) {
  const total = amount * (1 + ratePct / 100);
  return total / Math.max(termDays / 30, 1);
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */
function ScoreRing({ score, tier }: { score: number; tier: string }) {
  const t = TIERS[tier] ?? TIERS.bronze;
  const displayScore = Math.min(Math.round(score), 100);
  const r = 52;
  const circ = 2 * Math.PI * r;
  const dash = ((displayScore / 100) * circ).toFixed(1);

  return (
    <div className="flex flex-col items-center py-6">
      <div className="relative w-36 h-36">
        <svg width="144" height="144" viewBox="0 0 144 144" className="-rotate-90">
          <circle cx="72" cy="72" r={r} fill="none" stroke="#F3F4F6" strokeWidth="12" />
          <circle
            cx="72" cy="72" r={r} fill="none"
            stroke={t.ring} strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`}
            style={{ transition: "stroke-dasharray 0.6s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-4xl font-black text-gray-900">{displayScore}</span>
          <span className="text-xs text-gray-500">/ 100</span>
        </div>
      </div>
      <span
        className="mt-3 px-4 py-1 rounded-full text-xs font-bold tracking-wider"
        style={{ background: t.bg, color: t.color }}
      >
        {t.label}
      </span>
    </div>
  );
}

function FactorBar({ label, value, max }: { label: string; value: number; max: number }) {
  const percent = pct(value);
  const pts = Math.round(value * max);
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs text-gray-600 mb-1">
        <span>{label}</span>
        <span className="font-semibold text-gray-900">{pts}/{max} pts</span>
      </div>
      <div className="h-2.5 rounded-full overflow-hidden" style={{ background: "#F3F4F6" }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${percent}%`, background: "#1A6B32" }}
        />
      </div>
    </div>
  );
}

/* ─── Loan card ───────────────────────────────────────────────────────────── */
function LoanCard({
  loan, userId, walletId, onRepaid,
}: {
  loan: any; userId: string; walletId: string; onRepaid: () => void;
}) {
  const { token } = useAuth();
  const [repayAmount, setRepayAmount] = useState("");
  const [showRepay, setShowRepay] = useState(false);
  const [error, setError] = useState("");

  const repayMut = useMutation({
    mutationFn: async () => {
      const body = await apiFetch<any>(`/credit/loans/${loan.id}/repay`, token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() } as any,
        body: JSON.stringify({ walletId, amount: parseFloat(repayAmount), userId }),
      });
      return body;
    },
    onSuccess: (data) => {
      setShowRepay(false);
      setRepayAmount("");
      setError("");
      if (data.isFullyRepaid) onRepaid();
      else onRepaid(); // refresh in all cases
    },
    onError: (err: any) => setError(err.message ?? "Remboursement échoué"),
  });

  const repaid   = Number(loan.amountRepaid);
  const total    = Number(loan.amount);
  const progress = Math.min((repaid / total) * 100, 100);
  const isOverdue = loan.dueDate && new Date(loan.dueDate) < new Date();
  const monthly  = monthlyPayment(total, Number(loan.interestRate), Number(loan.termDays));

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="font-bold text-gray-900">{formatXOF(total)}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Remboursé: <span className="font-medium text-gray-700">{formatXOF(repaid)}</span>
            </p>
          </div>
          <span
            className="text-xs px-2 py-1 rounded-full font-medium"
            style={isOverdue
              ? { background: "#FEF2F2", color: "#DC2626" }
              : { background: "#F0FDF4", color: "#16A34A" }
            }
          >
            {isOverdue ? "En retard" : "En cours"}
          </span>
        </div>

        <div className="mb-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Progression</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: "#F3F4F6" }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${progress}%`, background: isOverdue ? "#EF4444" : "#1A6B32" }}
            />
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>
            Échéance:{" "}
            <span className={`font-medium ${isOverdue ? "text-red-600" : "text-gray-700"}`}>
              {loan.dueDate ? new Date(loan.dueDate).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "—"}
            </span>
          </span>
          <span>Mensualité: <span className="font-medium text-gray-700">{formatXOF(monthly)}</span></span>
        </div>
      </div>

      <div className="border-t border-gray-50 p-3">
        {error && (
          <p className="text-xs text-red-600 mb-2 px-1">{error}</p>
        )}
        {showRepay ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                type="number"
                value={repayAmount}
                onChange={e => setRepayAmount(e.target.value)}
                placeholder={`Max: ${formatXOF(total - repaid)}`}
                inputMode="decimal"
                className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none"
              />
              <button
                onClick={() => repayMut.mutate()}
                disabled={repayMut.isPending || !repayAmount}
                className="px-4 py-2 rounded-xl font-semibold text-white text-sm flex items-center gap-1 disabled:opacity-60"
                style={{ background: "#1A6B32", minHeight: 44 }}
              >
                {repayMut.isPending && <Loader2 size={14} className="animate-spin" />}
                OK
              </button>
              <button
                onClick={() => { setShowRepay(false); setError(""); }}
                className="px-3 py-2 rounded-xl text-sm text-gray-500 border border-gray-200"
                style={{ minHeight: 44 }}
              >
                Annuler
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowRepay(true)}
            className="w-full py-2.5 rounded-xl font-semibold text-sm border-2 transition-colors"
            style={{ borderColor: "#1A6B32", color: "#1A6B32", minHeight: 44 }}
          >
            Rembourser
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Main page ───────────────────────────────────────────────────────────── */
export default function Credit() {
  const { token, user } = useAuth();
  const qc = useQueryClient();

  const [loanAmount, setLoanAmount]     = useState("");
  const [termDays, setTermDays]         = useState(30);
  const [applyError, setApplyError]     = useState("");
  const [applySuccess, setApplySuccess] = useState("");
  const [showFactors, setShowFactors]   = useState(false);

  /* Wallet */
  const walletsQ = useQuery({
    queryKey: ["wallets", user?.id],
    queryFn: () => apiFetch<any>(`/wallets?userId=${user?.id}&limit=1`, token),
    enabled: !!user?.id,
    staleTime: 15_000,
  });
  const wallet = walletsQ.data?.wallets?.[0] ?? null;

  /* Credit score */
  const scoreQ = useQuery({
    queryKey: ["credit-score", user?.id],
    queryFn: () => apiFetch<any>(`/credit/scores/${user?.id}`, token),
    enabled: !!user?.id,
    retry: false,
    staleTime: 30_000,
  });
  const score = scoreQ.data;

  /* Loans */
  const loansQ = useQuery({
    queryKey: ["loans", user?.id],
    queryFn: async () => {
      const data = await apiFetch<any>("/credit/loans?status=disbursed&limit=50", token);
      return { loans: (data.loans ?? []).filter((l: any) => l.userId === user?.id) };
    },
    enabled: !!user?.id,
    staleTime: 15_000,
  });
  const activeLoans = loansQ.data?.loans ?? [];
  const hasActiveLoan = activeLoans.length > 0;

  /* Mutations */
  const computeMut = useMutation({
    mutationFn: () => apiFetch<any>(`/credit/scores/${user?.id}/compute`, token, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["credit-score", user?.id] }),
  });

  const applyMut = useMutation({
    mutationFn: async () => {
      if (!wallet) throw new Error("Wallet introuvable");
      const amt = parseFloat(loanAmount);
      if (!amt || amt <= 0) throw new Error("Montant invalide");
      if (amt > (score?.maxLoanAmount ?? 0)) throw new Error(`Maximum: ${formatXOF(score.maxLoanAmount)}`);
      return apiFetch<any>("/credit/loans", token, {
        method: "POST",
        body: JSON.stringify({
          userId: user?.id,
          walletId: wallet.id,
          amount: amt,
          currency: "XOF",
          termDays,
          purpose: "Prêt personnel KOWRI",
        }),
      });
    },
    onSuccess: (data) => {
      setApplySuccess(`${formatXOF(data.amount)} crédités sur votre wallet !`);
      setLoanAmount("");
      qc.invalidateQueries({ queryKey: ["loans", user?.id] });
      qc.invalidateQueries({ queryKey: ["wallets", user?.id] });
    },
    onError: (err: any) => setApplyError(err.message ?? "Demande échouée"),
  });

  /* Derived */
  const eligible     = (score?.score ?? 0) >= 40;
  const maxAmount    = score?.maxLoanAmount ?? 0;
  const rate         = score?.interestRate  ?? 12;
  const loanAmt      = parseFloat(loanAmount) || 0;
  const projectedRep = loanAmt > 0 ? monthlyPayment(loanAmt, rate, termDays) : 0;

  function handleApply(e: React.FormEvent) {
    e.preventDefault();
    setApplyError("");
    setApplySuccess("");
    applyMut.mutate();
  }

  return (
    <div className="min-h-screen pb-24" style={{ background: "#FAFAF8" }}>
      <TopBar title="Crédit" />

      <main className="px-4 pt-4 pb-6 max-w-lg mx-auto space-y-5">

        {/* ─── Score card ──────────────────────────────────────── */}
        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
          {scoreQ.isLoading ? (
            <div className="py-10 flex flex-col items-center gap-4 animate-pulse">
              <div className="w-36 h-36 rounded-full bg-gray-100" />
              <div className="h-4 w-28 bg-gray-100 rounded" />
              <div className="h-3 w-48 bg-gray-100 rounded" />
            </div>
          ) : !score ? (
            <div className="py-8 flex flex-col items-center px-6 text-center">
              <div className="w-16 h-16 rounded-2xl mb-4 flex items-center justify-center" style={{ background: "#FEF3C7" }}>
                <TrendingUp size={28} style={{ color: "#D97706" }} />
              </div>
              <p className="font-bold text-gray-900 mb-1">Pas encore de score</p>
              <p className="text-sm text-gray-500 mb-5">
                Calculez votre score de crédit pour accéder aux prêts KOWRI
              </p>
              <button
                onClick={() => computeMut.mutate()}
                disabled={computeMut.isPending}
                className="px-6 py-3 rounded-xl font-bold text-white text-sm flex items-center gap-2 disabled:opacity-70"
                style={{ background: "#1A6B32", minHeight: 44 }}
              >
                {computeMut.isPending && <Loader2 size={16} className="animate-spin" />}
                Calculer mon score
              </button>
            </div>
          ) : (
            <div className="px-5 pb-5">
              <ScoreRing score={score.score} tier={score.tier} />

              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="rounded-2xl p-3 text-center" style={{ background: "#F0FDF4" }}>
                  <p className="text-xs text-gray-500 mb-0.5">Éligible jusqu'à</p>
                  <p className="font-bold text-sm" style={{ color: "#1A6B32" }}>{formatXOF(maxAmount)}</p>
                </div>
                <div className="rounded-2xl p-3 text-center" style={{ background: "#FFFBEB" }}>
                  <p className="text-xs text-gray-500 mb-0.5">Taux d'intérêt</p>
                  <p className="font-bold text-sm" style={{ color: "#D97706" }}>{rate}% / an</p>
                </div>
              </div>

              {/* Factor bars — collapsible */}
              <button
                onClick={() => setShowFactors(f => !f)}
                className="w-full flex items-center justify-between text-sm font-semibold text-gray-700 mb-3 py-1"
              >
                <span>Facteurs du score</span>
                {showFactors ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>

              {showFactors && (
                <div className="mb-3">
                  {FACTORS.map(f => (
                    <FactorBar
                      key={f.key}
                      label={f.label}
                      value={score.factors?.[f.key] ?? 0}
                      max={f.max}
                    />
                  ))}
                </div>
              )}

              <button
                onClick={() => computeMut.mutate()}
                disabled={computeMut.isPending}
                className="w-full py-2.5 rounded-xl font-semibold text-sm border border-gray-200 flex items-center justify-center gap-2 disabled:opacity-60"
                style={{ color: "#1A6B32", minHeight: 44 }}
              >
                {computeMut.isPending && <Loader2 size={14} className="animate-spin" />}
                Recalculer
              </button>
            </div>
          )}
        </div>

        {/* ─── Low score tip ──────────────────────────────────── */}
        {score && !eligible && (
          <div className="rounded-2xl p-4 border border-amber-100 flex gap-3" style={{ background: "#FFFBEB" }}>
            <AlertTriangle size={18} style={{ color: "#D97706" }} className="flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-800 mb-1">Score insuffisant (min. 40)</p>
              <ul className="text-xs text-amber-700 space-y-0.5 list-disc list-inside">
                <li>Effectuez plus de transactions</li>
                <li>Cotisez régulièrement dans les tontines</li>
                <li>Constituez une épargne</li>
              </ul>
            </div>
          </div>
        )}

        {/* ─── Active loans ──────────────────────────────────── */}
        {loansQ.isLoading && (
          <div className="space-y-3">
            {[0,1].map(i => (
              <div key={i} className="bg-white rounded-2xl h-36 animate-pulse border border-gray-100" />
            ))}
          </div>
        )}

        {activeLoans.length > 0 && (
          <section>
            <h2 className="font-bold text-gray-900 mb-3 text-base">Prêts en cours</h2>
            <div className="space-y-3">
              {activeLoans.map((loan: any) => (
                <LoanCard
                  key={loan.id}
                  loan={loan}
                  userId={user?.id ?? ""}
                  walletId={wallet?.id ?? ""}
                  onRepaid={() => {
                    qc.invalidateQueries({ queryKey: ["loans", user?.id] });
                    qc.invalidateQueries({ queryKey: ["wallets", user?.id] });
                  }}
                />
              ))}
            </div>
          </section>
        )}

        {/* ─── Apply section ─────────────────────────────────── */}
        {score && eligible && !hasActiveLoan && (
          <section>
            <h2 className="font-bold text-gray-900 mb-3 text-base">Demander un prêt</h2>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-4 pt-4 pb-2 flex items-center gap-3">
                <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "#F0FDF4" }}>
                  <CheckCircle2 size={20} style={{ color: "#1A6B32" }} />
                </div>
                <div>
                  <p className="font-semibold text-gray-900 text-sm">Vous êtes éligible</p>
                  <p className="text-xs text-gray-500">Jusqu'à {formatXOF(maxAmount)} · {rate}% / an</p>
                </div>
              </div>

              <form onSubmit={handleApply} className="p-4 space-y-4">
                {applySuccess && (
                  <div className="px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2" style={{ background: "#F0FDF4", color: "#16A34A" }}>
                    <CheckCircle2 size={16} />
                    {applySuccess}
                  </div>
                )}
                {applyError && (
                  <div className="px-4 py-3 rounded-xl text-sm font-medium" style={{ background: "#FEF2F2", color: "#DC2626" }}>
                    {applyError}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Montant souhaité (FCFA)
                  </label>
                  <input
                    type="number"
                    value={loanAmount}
                    onChange={e => setLoanAmount(e.target.value)}
                    placeholder="Ex: 50 000"
                    inputMode="decimal"
                    max={maxAmount}
                    className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none"
                    style={{ minHeight: 48 }}
                  />
                  <p className="text-xs text-gray-400 mt-1">Maximum: {formatXOF(maxAmount)}</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Durée</label>
                  <div className="grid grid-cols-3 gap-2">
                    {TERM_OPTIONS.map(d => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setTermDays(d)}
                        className="py-3 rounded-xl text-xs font-semibold border transition-all"
                        style={{
                          background: termDays === d ? "#F0FDF4" : "#F9FAFB",
                          borderColor: termDays === d ? "#1A6B32" : "#E5E7EB",
                          color: termDays === d ? "#1A6B32" : "#6B7280",
                          minHeight: 44,
                        }}
                      >
                        {d} jours
                      </button>
                    ))}
                  </div>
                </div>

                {loanAmt > 0 && (
                  <div className="rounded-xl p-3 space-y-1.5 border border-gray-100" style={{ background: "#F9FAFB" }}>
                    <Row label="Capital" value={formatXOF(loanAmt)} />
                    <Row label={`Intérêts (${rate}%)`} value={formatXOF(loanAmt * rate / 100)} />
                    <Row label="Total à rembourser" value={formatXOF(loanAmt * (1 + rate / 100))} bold />
                    <Row label="Mensualité estimée" value={formatXOF(projectedRep)} />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={applyMut.isPending || !loanAmount}
                  className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-70"
                  style={{ background: "#1A6B32", minHeight: 52 }}
                >
                  {applyMut.isPending && <Loader2 size={16} className="animate-spin" />}
                  Demander ce prêt
                </button>
              </form>
            </div>
          </section>
        )}

        {score && hasActiveLoan && (
          <p className="text-xs text-center text-gray-400 pb-2">
            Remboursez votre prêt actuel avant d'en demander un nouveau.
          </p>
        )}
      </main>

      <BottomNav />
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-gray-500">{label}</span>
      <span className={bold ? "font-bold text-gray-900" : "text-gray-700"}>{value}</span>
    </div>
  );
}
