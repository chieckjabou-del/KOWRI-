import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X, Loader2, ChevronDown, ChevronUp, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

/* ─── Helpers ──────────────────────────────────────────────────────────────── */
const TERM_OPTIONS = [
  { days: 30,  label: "30 jours" },
  { days: 60,  label: "60 jours" },
  { days: 90,  label: "3 mois"   },
  { days: 180, label: "6 mois"   },
];

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string }> = {
  active:  { label: "ACTIF",   bg: "#F0FDF4", color: "#16A34A" },
  matured: { label: "MATURÉ",  bg: "#EFF6FF", color: "#2563EB" },
  broken:  { label: "ROMPU",   bg: "#FEF2F2", color: "#DC2626" },
};

function projectedYield(amount: number, rateAnnual: number, days: number): number {
  return amount * (rateAnnual / 100) * (days / 365);
}

function countdown(daysRemaining: number): string {
  if (daysRemaining <= 0) return "Mature maintenant";
  if (daysRemaining === 1) return "Demain";
  return `Mature dans ${daysRemaining} jour${daysRemaining > 1 ? "s" : ""}`;
}

/* ─── Plan card ────────────────────────────────────────────────────────────── */
function PlanCard({
  plan, walletId, onAction,
}: {
  plan: any; walletId: string; onAction: () => void;
}) {
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [showBreakWarn, setShowBreakWarn] = useState(false);

  const breakMut = useMutation({
    mutationFn: (isBreak: boolean) =>
      apiFetch<any>(`/savings/plans/${plan.id}/break`, token, {
        method: "POST",
        body: JSON.stringify({ targetWalletId: walletId }),
      }),
    onSuccess: () => { setShowBreakWarn(false); setError(""); onAction(); },
    onError: (err: any) => setError(err.message ?? "Opération échouée"),
  });

  const s = STATUS_CONFIG[plan.status] ?? STATUS_CONFIG.active;

  const lockedAmt = Number(plan.lockedAmount);
  const accrued   = Number(plan.accruedYield);
  const rate      = Number(plan.interestRate);
  const daysRem   = Number(plan.daysRemaining);
  const isMatured = plan.isMatured || daysRem <= 0;
  const isActive  = plan.status === "active";
  const isBroken  = plan.status === "broken";

  // Progress: calculate days elapsed
  const createdAt  = new Date(plan.createdAt);
  const maturesAt  = new Date(plan.maturityDate);
  const totalMs    = maturesAt.getTime() - createdAt.getTime();
  const elapsedMs  = Date.now() - createdAt.getTime();
  const progress   = Math.min(Math.max((elapsedMs / totalMs) * 100, 0), 100);
  const dailyYield = lockedAmt * (rate / 100) / 365;
  const totalAtMat = lockedAmt + projectedYield(lockedAmt, rate, totalMs / 86400000);

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full text-left p-4"
      >
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1 min-w-0 pr-3">
            <p className="font-semibold text-gray-900 text-sm truncate">{plan.name}</p>
            <p className="text-2xl font-black text-gray-900 mt-1">{formatXOF(lockedAmt)}</p>
            <p className="text-xs text-gray-500 mt-0.5">{rate}% par an</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className="text-xs px-2 py-0.5 rounded-full font-bold" style={{ background: s.bg, color: s.color }}>
              {s.label}
            </span>
            {open ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
          </div>
        </div>

        {/* Accrued yield pill */}
        {accrued > 0 && (
          <p className="text-xs font-semibold mb-2" style={{ color: "#16A34A" }}>
            +{formatXOF(accrued)} de rendement
          </p>
        )}

        {/* Countdown */}
        <p className="text-xs text-gray-500 mb-2">
          {isBroken ? "Plan rompu" : countdown(daysRem)}
        </p>

        {/* Progress bar */}
        {!isBroken && (
          <div className="h-2 rounded-full overflow-hidden" style={{ background: "#F3F4F6" }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${progress}%`,
                background: isMatured ? "#2563EB" : "#1A6B32",
              }}
            />
          </div>
        )}
      </button>

      {/* Expanded details */}
      {open && (
        <div className="border-t border-gray-50 px-4 pb-4 pt-3 space-y-3">
          {error && (
            <div className="px-3 py-2 rounded-xl text-xs font-medium" style={{ background: "#FEF2F2", color: "#DC2626" }}>
              {error}
            </div>
          )}

          <div className="rounded-xl p-3 space-y-1.5" style={{ background: "#F9FAFB" }}>
            <DetailRow label="Rendement journalier" value={`${formatXOF(dailyYield)} / jour`} />
            <DetailRow label="Rendement accumulé"   value={formatXOF(accrued)} />
            <DetailRow label="Total à maturité"     value={formatXOF(totalAtMat)} bold />
            <DetailRow
              label="Date de maturité"
              value={maturesAt.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}
            />
          </div>

          {/* Action buttons — single ternary to keep DOM structure stable */}
          {showBreakWarn ? (
            <div className="rounded-xl border border-red-100 overflow-hidden" style={{ background: "#FEF2F2" }}>
              <div className="p-3 flex gap-2">
                <AlertTriangle size={16} style={{ color: "#DC2626" }} className="flex-shrink-0 mt-0.5" />
                <p className="text-xs text-red-700">
                  Pénalité de <strong>10% sur le rendement accumulé</strong>.
                  Vous recevrez {formatXOF(lockedAmt + accrued * 0.9)}.
                </p>
              </div>
              <div className="flex border-t border-red-100">
                <button
                  onClick={() => setShowBreakWarn(false)}
                  className="flex-1 py-2.5 text-xs font-medium text-gray-600"
                >
                  Annuler
                </button>
                <button
                  onClick={() => breakMut.mutate(true)}
                  disabled={breakMut.isPending}
                  className="flex-1 py-2.5 text-xs font-bold border-l border-red-100 flex items-center justify-center gap-1"
                  style={{ color: "#DC2626" }}
                >
                  {breakMut.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
                  Confirmer
                </button>
              </div>
            </div>
          ) : isMatured && isActive ? (
            <button
              onClick={() => breakMut.mutate(false)}
              disabled={breakMut.isPending}
              className="w-full py-3 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-70"
              style={{ background: "#2563EB", minHeight: 44 }}
            >
              {breakMut.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
              Débloquer maintenant
            </button>
          ) : !isMatured && isActive ? (
            <button
              onClick={() => setShowBreakWarn(true)}
              className="w-full py-3 rounded-xl font-semibold text-sm border border-red-200 flex items-center justify-center gap-2"
              style={{ color: "#DC2626", minHeight: 44 }}
            >
              Rupture anticipée
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-gray-500">{label}</span>
      <span className={bold ? "font-bold text-gray-900" : "text-gray-700"}>{value}</span>
    </div>
  );
}

/* ─── Main page ─────────────────────────────────────────────────────────────── */
export default function Savings() {
  const { token, user } = useAuth();
  const qc = useQueryClient();

  const [showModal, setShowModal]       = useState(false);
  const [formAmount, setFormAmount]     = useState("");
  const [formTerm, setFormTerm]         = useState(30);
  const [formName, setFormName]         = useState("");
  const [formError, setFormError]       = useState("");
  const [createSuccess, setCreateSuccess] = useState("");

  /* Wallet */
  const walletsQ = useQuery({
    queryKey: ["wallets", user?.id],
    queryFn: () => apiFetch<any>(`/wallets?userId=${user?.id}&limit=1`, token),
    enabled: !!user?.id,
    staleTime: 15_000,
  });
  const wallet     = walletsQ.data?.wallets?.[0] ?? null;
  const available  = parseFloat(wallet?.availableBalance ?? "0");

  /* Plans */
  const plansQ = useQuery({
    queryKey: ["savings-plans", user?.id],
    queryFn: () => apiFetch<any>(`/savings/plans?userId=${user?.id}`, token),
    enabled: !!user?.id,
    staleTime: 20_000,
  });
  const plans = plansQ.data?.plans ?? [];

  /* Rate */
  const rateQ = useQuery({
    queryKey: ["savings-rate", user?.id],
    queryFn: () => apiFetch<any>(`/savings/rate?userId=${user?.id}`, token),
    enabled: !!user?.id,
    staleTime: 60_000,
  });
  const annualRate = rateQ.data?.annualRate ?? 8;

  /* Summary */
  const summaryQ = useQuery({
    queryKey: ["savings-summary", user?.id],
    queryFn: () => apiFetch<any>(`/savings/summary/${user?.id}`, token),
    enabled: !!user?.id,
    staleTime: 20_000,
  });
  const summary = summaryQ.data;

  /* Create mutation */
  const createMut = useMutation({
    mutationFn: async () => {
      if (!wallet) throw new Error("Wallet introuvable");
      const amt = parseFloat(formAmount);
      if (!amt || amt <= 0) throw new Error("Montant invalide");
      if (amt > available) throw new Error("Solde insuffisant");
      return apiFetch<any>("/savings/plans", token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() } as any,
        body: JSON.stringify({
          userId: user?.id,
          walletId: wallet.id,
          name: formName.trim() || `Plan ${new Date().toLocaleDateString("fr-FR")}`,
          amount: amt,
          currency: "XOF",
          termDays: formTerm,
          earlyBreakPenalty: 0.1,
        }),
      });
    },
    onSuccess: (data) => {
      setCreateSuccess(`Plan créé ! ${formatXOF(data.lockedAmount)} bloqués.`);
      setFormAmount(""); setFormTerm(30); setFormName(""); setFormError("");
      setTimeout(() => { setShowModal(false); setCreateSuccess(""); }, 1800);
      qc.invalidateQueries({ queryKey: ["savings-plans", user?.id] });
      qc.invalidateQueries({ queryKey: ["savings-summary", user?.id] });
      qc.invalidateQueries({ queryKey: ["wallets", user?.id] });
    },
    onError: (err: any) => setFormError(err.message ?? "Erreur lors de la création"),
  });

  const amt         = parseFloat(formAmount) || 0;
  const yieldProj   = projectedYield(amt, annualRate, formTerm);
  const totalAtMat  = amt + yieldProj;

  return (
    <div className="min-h-screen pb-24" style={{ background: "#FAFAF8" }}>
      <TopBar title="Épargne" />

      <main className="px-4 pt-4 pb-6 max-w-lg mx-auto space-y-5">

        {/* ─── Header action ────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Mes Épargnes</h1>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-white text-sm"
            style={{ background: "#1A6B32", minHeight: 44 }}
          >
            <Plus size={16} />
            Nouveau Plan
          </button>
        </div>

        {/* ─── Summary stats ─────────────────────────────────────── */}
        {summaryQ.isLoading ? (
          <div className="grid grid-cols-3 gap-3 animate-pulse">
            {[0,1,2].map(i => <div key={i} className="h-20 bg-white rounded-2xl border border-gray-100" />)}
          </div>
        ) : summary ? (
          <div className="grid grid-cols-3 gap-3">
            <StatBox label="Total épargné"   value={formatXOF(summary.totalLocked ?? 0)} />
            <StatBox label="Rendement total" value={formatXOF(summary.totalYield  ?? 0)} accent />
            <StatBox label="Plans actifs"    value={String(summary.activePlans ?? 0)} />
          </div>
        ) : null}

        {/* ─── Plans list ────────────────────────────────────────── */}
        <section>
          {plansQ.isLoading ? (
            <div className="space-y-3">
              {[0,1].map(i => <div key={i} className="h-36 bg-white rounded-2xl animate-pulse border border-gray-100" />)}
            </div>
          ) : plans.length === 0 ? (
            <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-gray-100">
              <div className="w-14 h-14 rounded-2xl mx-auto mb-4 flex items-center justify-center text-2xl" style={{ background: "#F0FDF4" }}>
                🏦
              </div>
              <p className="font-semibold text-gray-900 mb-1">Aucun plan d'épargne</p>
              <p className="text-sm text-gray-500 mb-5">Commencez à épargner et gagnez des intérêts</p>
              <button
                onClick={() => setShowModal(true)}
                className="inline-flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-white text-sm"
                style={{ background: "#1A6B32", minHeight: 44 }}
              >
                <Plus size={16} />
                Créer mon premier plan
              </button>
            </div>
          ) : null}

          <div className="space-y-3">
            {plans.map((plan: any) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                walletId={wallet?.id ?? ""}
                onAction={() => {
                  qc.invalidateQueries({ queryKey: ["savings-plans", user?.id] });
                  qc.invalidateQueries({ queryKey: ["savings-summary", user?.id] });
                  qc.invalidateQueries({ queryKey: ["wallets", user?.id] });
                }}
              />
            ))}
          </div>
        </section>
      </main>

      <BottomNav />

      {/* ─── Create modal ─────────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowModal(false)} />
          <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 pb-8 max-h-[92dvh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xl font-bold text-gray-900">Nouveau Plan d'Épargne</h2>
              <button onClick={() => setShowModal(false)} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">
                <X size={20} className="text-gray-500" />
              </button>
            </div>

            {createSuccess && (
              <div className="mb-4 px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2" style={{ background: "#F0FDF4", color: "#16A34A" }}>
                <CheckCircle2 size={16} />
                {createSuccess}
              </div>
            )}

            {formError && (
              <div className="mb-4 px-4 py-3 rounded-xl text-sm font-medium" style={{ background: "#FEF2F2", color: "#DC2626" }}>
                {formError}
              </div>
            )}

            <form onSubmit={e => { e.preventDefault(); setFormError(""); createMut.mutate(); }} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Montant à bloquer (FCFA)</label>
                <input
                  type="number"
                  value={formAmount}
                  onChange={e => setFormAmount(e.target.value)}
                  placeholder="Ex: 25 000"
                  inputMode="decimal"
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none"
                  style={{ minHeight: 48 }}
                />
                {wallet && (
                  <p className="text-xs text-gray-400 mt-1">
                    Disponible: <span className="font-medium text-gray-600">{formatXOF(available)}</span>
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Durée</label>
                <div className="grid grid-cols-2 gap-2">
                  {TERM_OPTIONS.map(opt => (
                    <button
                      key={opt.days}
                      type="button"
                      onClick={() => setFormTerm(opt.days)}
                      className="py-3 rounded-xl text-xs font-semibold border transition-all"
                      style={{
                        background: formTerm === opt.days ? "#F0FDF4" : "#F9FAFB",
                        borderColor: formTerm === opt.days ? "#1A6B32" : "#E5E7EB",
                        color: formTerm === opt.days ? "#1A6B32" : "#6B7280",
                        minHeight: 44,
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {amt > 0 && (
                <div className="rounded-xl p-3 space-y-1.5 border border-gray-100" style={{ background: "#F9FAFB" }}>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Taux annuel</span>
                    <span className="font-medium text-gray-900">{annualRate}%</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Intérêts estimés</span>
                    <span className="font-semibold" style={{ color: "#16A34A" }}>+{formatXOF(yieldProj)}</span>
                  </div>
                  <div className="flex justify-between text-xs border-t border-gray-100 pt-1.5">
                    <span className="text-gray-700 font-medium">À maturité</span>
                    <span className="font-bold text-gray-900">{formatXOF(totalAtMat)}</span>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Nom du plan (optionnel)</label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="Ex: Épargne voyage"
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none"
                  style={{ minHeight: 48 }}
                />
              </div>

              <button
                type="submit"
                disabled={createMut.isPending || !formAmount}
                className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-70"
                style={{ background: "#1A6B32", minHeight: 52 }}
              >
                {createMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
                Créer ce plan
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-white rounded-2xl p-3 shadow-sm border border-gray-100 flex flex-col gap-1 text-center">
      <p className="text-xs text-gray-500 leading-tight">{label}</p>
      <p className="font-bold text-sm text-gray-900" style={accent ? { color: "#16A34A" } : {}}>
        {value}
      </p>
    </div>
  );
}
