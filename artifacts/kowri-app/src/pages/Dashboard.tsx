import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Plus, PiggyBank, X, Loader2, CheckCircle2, Share2, Users, TrendingUp,
  Zap, ChevronRight, Gift,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { WalletCard } from "@/components/WalletCard";
import { TontineCard, TontineCardSkeleton } from "@/components/TontineCard";
import { TransactionRow, TransactionRowSkeleton } from "@/components/TransactionRow";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

/* ─── Tontine type colors (for strip badges) ─────────────────────── */
const TYPE_COLORS: Record<string, string> = {
  classic:    "#1A6B32", investment: "#2563EB", project: "#D97706",
  solidarity: "#7C3AED", business:   "#0891B2", diaspora: "#4F46E5",
  yield:      "#EA580C", growth:     "#65A30D", hybrid:   "#1A6B32",
};

/* ─── Smart insight card ──────────────────────────────────────────── */
interface InsightProps {
  id: string;
  emoji: string;
  title: string;
  subtitle: string;
  href: string;
  color: string;
}
function InsightCard({ emoji, title, subtitle, href, color }: InsightProps) {
  return (
    <Link href={href}>
      <div
        className="flex items-center gap-3 rounded-2xl p-4 border cursor-pointer active:scale-[0.98] transition-transform"
        style={{ background: color + "10", borderColor: color + "30" }}
      >
        <span className="text-2xl flex-shrink-0">{emoji}</span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900 text-sm leading-tight">{title}</p>
          <p className="text-xs text-gray-500 mt-0.5 truncate">{subtitle}</p>
        </div>
        <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />
      </div>
    </Link>
  );
}

/* ─── Tontine mini-card (horizontal strip) ─────────────────────────── */
function TontineStrip({ tontine }: { tontine: any }) {
  const pct = tontine.maxMembers > 0
    ? Math.round(((tontine.currentRound ?? 1) / tontine.maxMembers) * 100)
    : 0;
  const color = TYPE_COLORS[tontine.type] ?? "#1A6B32";
  const r = 22; const circ = 2 * Math.PI * r;
  const dash = ((pct / 100) * circ).toFixed(2);

  return (
    <Link href={`/tontines/${tontine.id}`}>
      <div className="flex-shrink-0 w-36 bg-white rounded-2xl p-4 border border-gray-100 shadow-sm cursor-pointer active:scale-[0.97] transition-transform">
        <div className="relative w-12 h-12 mx-auto mb-3">
          <svg width="48" height="48" viewBox="0 0 48 48" className="-rotate-90">
            <circle cx="24" cy="24" r={r} fill="none" stroke="#F3F4F6" strokeWidth="4" />
            <circle cx="24" cy="24" r={r} fill="none" stroke={color} strokeWidth="4"
              strokeLinecap="round" strokeDasharray={`${dash} ${circ}`} />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-gray-900">
            {pct}%
          </span>
        </div>
        <p className="text-xs font-semibold text-gray-900 text-center truncate">{tontine.name}</p>
        <p className="text-xs text-gray-400 text-center mt-0.5">
          {formatXOF(tontine.contributionAmount ?? 0)}
        </p>
      </div>
    </Link>
  );
}

/* ─── Main Dashboard ─────────────────────────────────────────────── */
const DURATIONS = [
  { days: 30, label: "1 mois" }, { days: 60, label: "2 mois" },
  { days: 90, label: "3 mois" }, { days: 180, label: "6 mois" },
];

const INPUT_CLS = "w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none focus:border-[#1A6B32] transition-colors";

export default function Dashboard() {
  const { token, user } = useAuth();
  const qc = useQueryClient();

  const [showSave,    setShowSave]    = useState(false);
  const [saveAmount,  setSaveAmount]  = useState("");
  const [saveDays,    setSaveDays]    = useState(90);
  const [planName,    setPlanName]    = useState("");
  const [saveError,   setSaveError]   = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);

  /* Queries */
  const walletsQ = useQuery({
    queryKey: ["wallets", user?.id],
    queryFn:  () => apiFetch<any>(`/wallets?userId=${user?.id}&limit=1`, token),
    enabled:  !!user?.id,
    staleTime: 10_000,
  });

  const wallet = walletsQ.data?.wallets?.[0] ?? null;

  const txQ = useQuery({
    queryKey: ["transactions", wallet?.id],
    queryFn:  () => apiFetch<any>(`/transactions?walletId=${wallet?.id}&limit=5`, token),
    enabled:  !!wallet?.id,
    staleTime: 10_000,
  });

  const tontinesQ = useQuery({
    queryKey: ["tontines", user?.id],
    queryFn:  () => apiFetch<any>(`/tontines?userId=${user?.id}&limit=6`, token),
    enabled:  !!user?.id,
    staleTime: 15_000,
  });

  const savingsQ = useQuery({
    queryKey: ["savings-summary", user?.id],
    queryFn:  () => apiFetch<any>(`/savings/plans?userId=${user?.id}&status=active`, token),
    enabled:  !!user?.id,
    staleTime: 30_000,
  });

  const transactions = Array.isArray(txQ.data?.transactions)      ? txQ.data.transactions      : [];
  const tontines     = Array.isArray(tontinesQ.data?.tontines)    ? tontinesQ.data.tontines    : [];
  const savingsPlans = Array.isArray(savingsQ.data?.plans)        ? savingsQ.data.plans        : [];

  /* Smart insights */
  const insights: InsightProps[] = [];
  const activeTontine = tontines.find((t: any) => t.status === "active");
  if (activeTontine) {
    const pct   = activeTontine.maxMembers > 0
      ? Math.round(((activeTontine.currentRound ?? 1) / activeTontine.maxMembers) * 100) : 0;
    const days  = activeTontine.nextPayoutAt
      ? Math.max(0, Math.round((new Date(activeTontine.nextPayoutAt).getTime() - Date.now()) / 86_400_000)) : null;
    insights.push({
      id: `tontine-${activeTontine.id}`,
      emoji: "🤝",
      title: `Ta tontine est à ${pct}%`,
      subtitle: days != null ? `Prochain paiement dans ${days}j` : activeTontine.name,
      href:  `/tontines/${activeTontine.id}`,
      color: "#1A6B32",
    });
  }

  const matureSaving = savingsPlans.find((p: any) => {
    const days = Math.round((new Date(p.maturityDate).getTime() - Date.now()) / 86_400_000);
    return days <= 7 && days >= 0;
  });
  if (matureSaving) {
    const days = Math.max(0, Math.round((new Date(matureSaving.maturityDate).getTime() - Date.now()) / 86_400_000));
    insights.push({
      id: `savings-${matureSaving.id}`,
      emoji: "💰",
      title: "Ton épargne arrive à maturité",
      subtitle: days === 0 ? "Disponible aujourd'hui !" : `Dans ${days} jour${days > 1 ? "s" : ""}`,
      href:  "/savings",
      color: "#D97706",
    });
  }

  if (insights.length === 0 && tontines.length === 0) {
    insights.push({
      id: "onboarding-tontine",
      emoji: "🚀",
      title: "Lance ta première tontine",
      subtitle: "Crée ou rejoins une tontine et débloque le crédit",
      href:  "/tontines",
      color: "#2563EB",
    });
  }

  /* Savings mutation */
  const saveMut = useMutation({
    mutationFn: () => {
      if (!wallet || !saveAmount || parseFloat(saveAmount) <= 0)
        throw new Error("Montant invalide");
      const name = planName.trim() || `Épargne ${new Date().toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}`;
      return apiFetch<any>("/savings/plans", token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() },
        body: JSON.stringify({
          userId: user?.id, walletId: wallet.id,
          name, amount: parseFloat(saveAmount),
          currency: "XOF", termDays: saveDays,
        }),
      });
    },
    onSuccess: () => {
      setSaveSuccess(true);
      qc.invalidateQueries({ queryKey: ["wallets", user?.id] });
      qc.invalidateQueries({ queryKey: ["savings-summary", user?.id] });
    },
    onError: (e: any) => setSaveError(e.message ?? "Erreur"),
  });

  function openSaveModal() {
    setSaveAmount(""); setSaveDays(90); setPlanName(""); setSaveError(""); setSaveSuccess(false);
    setShowSave(true);
  }

  function closeSaveModal() { setShowSave(false); setSaveSuccess(false); }

  function shareReferral() {
    const referralCode = user?.id?.slice(0, 8).toUpperCase() ?? "";
    const inviteLink = `https://akwe.app/register?ref=${referralCode}&utm_source=whatsapp&utm_medium=referral&utm_campaign=growth-mode`;
    const msg = `Rejoins-moi sur AKWE, la super-app financière africaine ! 🌍\nUtilise mon code : ${referralCode}\n${inviteLink}`;
    if (navigator.share) {
      navigator.share({ title: "AKWE — Invitation", text: msg }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(msg).catch(() => {});
    }
  }

  return (
    <div className="min-h-screen pb-24" style={{ background: "#FAFAF8" }}>
      <TopBar />

      <main className="px-4 pt-5 pb-4 max-w-lg mx-auto space-y-6">

        {/* Greeting */}
        <div>
          <p className="text-gray-500 text-sm">Bonjour 👋</p>
          <h1 className="text-2xl font-bold text-gray-900">
            {user?.firstName} {user?.lastName}
          </h1>
        </div>

        {/* Wallet card (4 quick actions, balance toggle) */}
        {walletsQ.isLoading ? (
          <WalletCard balance={0} availableBalance={0} status="active" walletId="" isLoading />
        ) : wallet ? (
          <WalletCard
            balance={wallet.balance}
            availableBalance={wallet.availableBalance}
            status={wallet.status}
            walletId={wallet.id}
            onDeposit={openSaveModal}
          />
        ) : (
          <div className="rounded-3xl p-6 bg-white border border-gray-100 text-center text-gray-500 text-sm shadow-sm">
            Aucun wallet trouvé.{" "}
            <Link href="/profile">
              <span style={{ color: "#1A6B32" }} className="font-medium">Contacter le support</span>
            </Link>
          </div>
        )}

        {/* Smart insights — always rendered (CSS hidden when empty) to avoid insertBefore */}
        <section className="space-y-2" style={{ display: insights.length > 0 ? undefined : "none" }}>
          {insights.slice(0, 2).map((ins) => (
            <InsightCard key={ins.id} {...ins} />
          ))}
        </section>

        {/* Tontines horizontal strip */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-gray-900 text-base">Mes Tontines</h2>
            <Link href="/tontines">
              <span className="text-sm font-medium" style={{ color: "#1A6B32" }}>Voir tout</span>
            </Link>
          </div>

          {tontinesQ.isLoading ? (
            <div className="flex gap-3 overflow-x-auto pb-1 -mx-4 px-4">
              {[0,1,2].map(i => (
                <div key={i} className="flex-shrink-0 w-36 h-32 bg-white rounded-2xl animate-pulse border border-gray-100" />
              ))}
            </div>
          ) : tontines.length === 0 ? (
            <div className="bg-white rounded-2xl p-6 text-center shadow-sm border border-gray-100">
              <p className="text-gray-500 text-sm mb-4">Rejoignez une tontine ou créez la vôtre</p>
              <Link
                href="/tontines"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-white text-sm"
                style={{ background: "#1A6B32", minHeight: 44 }}
              >
                <Plus size={16} /> Nouvelle Tontine
              </Link>
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4">
              {tontines.map((t: any) => <TontineStrip key={t.id} tontine={t} />)}
              <Link href="/tontines/create">
                <div className="flex-shrink-0 w-36 bg-white rounded-2xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-[#1A6B32] transition-colors" style={{ minHeight: 128 }}>
                  <Plus size={20} className="text-gray-400" />
                  <span className="text-xs font-medium text-gray-400">Nouvelle</span>
                </div>
              </Link>
            </div>
          )}
        </section>

        {/* Quick links row (savings + diaspora) */}
        <div className="grid grid-cols-2 gap-3">
          <Link
            href="/savings"
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl text-sm font-semibold border border-gray-200 bg-white shadow-sm"
            style={{ minHeight: 48 }}
          >
            <PiggyBank size={16} className="text-gray-500" />
            <span className="text-gray-700">Épargne</span>
          </Link>
          <Link
            href="/credit"
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl text-sm font-semibold text-white shadow-sm"
            style={{ background: "linear-gradient(135deg, #1A6B32 0%, #2D9148 100%)", minHeight: 48 }}
          >
            <TrendingUp size={16} />
            Crédit
          </Link>
        </div>

        {/* Recent transactions */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-gray-900 text-base">Transactions récentes</h2>
            <Link href="/profile">
              <span className="text-sm font-medium" style={{ color: "#1A6B32" }}>Voir tout</span>
            </Link>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 divide-y divide-gray-50 px-4">
            {txQ.isLoading ? (
              [0,1,2].map(i => <TransactionRowSkeleton key={i} />)
            ) : transactions.length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-sm">Aucune transaction récente</div>
            ) : (
              transactions.map((tx: any) => (
                <TransactionRow
                  key={tx.id}
                  type={tx.type}
                  amount={tx.amount}
                  description={tx.description}
                  createdAt={tx.createdAt}
                  fromWalletId={tx.fromWalletId}
                  myWalletId={wallet?.id ?? ""}
                />
              ))
            )}
          </div>
        </section>

        {/* More features strip */}
        <section>
          <h2 className="font-bold text-gray-900 text-base mb-3">Découvrir</h2>
          <div className="grid grid-cols-3 gap-3">
            {[
              { icon: "🌍", label: "Diaspora",     href: "/diaspora" },
              { icon: "📈", label: "Investir",      href: "/invest" },
              { icon: "🛡️", label: "Assurance",    href: "/insurance" },
              { icon: "🎨", label: "Créateur",      href: "/creator" },
              { icon: "🏪", label: "Marchand",      href: "/merchant" },
              { icon: "🏦", label: "Agent",          href: "/agent" },
            ].map(({ icon, label, href }) => (
              <Link key={href} href={href}>
                <div className="bg-white rounded-2xl p-4 flex flex-col items-center gap-2 border border-gray-100 shadow-sm cursor-pointer active:scale-[0.97] transition-transform" style={{ minHeight: 80 }}>
                  <span className="text-2xl">{icon}</span>
                  <span className="text-xs font-semibold text-gray-700 text-center leading-tight">{label}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* Viral CTA — Referral */}
        <div
          className="rounded-3xl p-5 flex items-center gap-4"
          style={{ background: "linear-gradient(135deg, #1A6B32 0%, #2D9148 100%)" }}
        >
          <div className="w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center flex-shrink-0">
            <Gift size={24} className="text-white" />
          </div>
          <div className="flex-1 text-white">
            <p className="font-bold text-sm leading-tight">Inviter un ami</p>
            <p className="text-xs opacity-80 mt-0.5">+300 XOF pour toi • +500 XOF pour lui</p>
          </div>
          <button
            onClick={shareReferral}
            className="flex items-center gap-1.5 bg-white/20 hover:bg-white/30 px-3 py-2 rounded-xl text-white text-xs font-bold transition-colors flex-shrink-0"
          >
            <Share2 size={13} /> Inviter
          </button>
        </div>

        {/* Tontine CTA */}
        <Link href="/tontines/create">
          <div className="flex items-center gap-4 bg-white rounded-2xl p-4 border border-gray-100 shadow-sm cursor-pointer active:scale-[0.98] transition-transform">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: "#F0FDF4" }}>
              <Users size={22} style={{ color: "#1A6B32" }} />
            </div>
            <div className="flex-1">
              <p className="font-bold text-gray-900 text-sm">Créer une tontine</p>
              <p className="text-xs text-gray-500 mt-0.5">Débloque l'accès au crédit AKWE</p>
            </div>
            <Zap size={18} style={{ color: "#D97706" }} />
          </div>
        </Link>

      </main>

      <BottomNav />

      {/* ─── Savings bottom sheet ─────────────────────────────────── */}
      {showSave ? (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={closeSaveModal} />
          <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 pb-8 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xl font-bold text-gray-900">
                {saveSuccess ? "Épargne créée !" : "Épargner depuis mon wallet"}
              </h2>
              <button onClick={closeSaveModal} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">
                <X size={20} className="text-gray-500" />
              </button>
            </div>

            {saveSuccess ? (
              <div className="text-center py-6">
                <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "#F0FDF4" }}>
                  <CheckCircle2 size={32} style={{ color: "#1A6B32" }} />
                </div>
                <p className="font-semibold text-gray-900 mb-1">Plan d'épargne créé !</p>
                <p className="text-sm text-gray-500 mb-6">
                  {formatXOF(parseFloat(saveAmount))} verrouillé pour {saveDays} jours
                </p>
                <button onClick={closeSaveModal} className="w-full py-4 rounded-xl font-bold text-white text-sm" style={{ background: "#1A6B32", minHeight: 52 }}>
                  Fermer
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Montant (XOF)</label>
                  <div className="relative">
                    <input
                      type="number" value={saveAmount}
                      onChange={e => setSaveAmount(e.target.value)}
                      placeholder="Ex: 50 000" inputMode="decimal"
                      className={INPUT_CLS} style={{ minHeight: 52, paddingRight: 56 }}
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-medium text-gray-400">XOF</span>
                  </div>
                  {wallet ? (
                    <p className="text-xs text-gray-400 mt-1">Disponible : {formatXOF(wallet.availableBalance)}</p>
                  ) : null}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Nom du plan (optionnel)</label>
                  <input type="text" value={planName} onChange={e => setPlanName(e.target.value)}
                    placeholder="Ex: Fonds de voyage" className={INPUT_CLS} style={{ minHeight: 48 }} />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Durée</label>
                  <div className="grid grid-cols-4 gap-2">
                    {DURATIONS.map(({ days, label }) => (
                      <button
                        key={days} onClick={() => setSaveDays(days)}
                        className="py-3 rounded-xl text-xs font-semibold border transition-all"
                        style={{
                          background:  saveDays === days ? "#F0FDF4" : "#F9FAFB",
                          borderColor: saveDays === days ? "#1A6B32" : "#E5E7EB",
                          color:       saveDays === days ? "#1A6B32" : "#6B7280",
                          minHeight: 44,
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl p-3" style={{ background: "#F0FDF4", border: "1px solid #BBF7D0" }}>
                  <p className="text-xs font-semibold text-green-800 mb-1">💡 Plan à terme fixe</p>
                  <p className="text-xs text-green-700">
                    Vos fonds seront verrouillés pendant {saveDays} jours avec un taux d'intérêt selon votre profil.
                  </p>
                </div>

                {saveError ? (
                  <div className="px-4 py-3 rounded-xl text-sm font-medium" style={{ background: "#FEF2F2", color: "#DC2626" }}>
                    {saveError}
                  </div>
                ) : null}

                <button
                  onClick={() => { setSaveError(""); saveMut.mutate(); }}
                  disabled={saveMut.isPending || !saveAmount || parseFloat(saveAmount) <= 0}
                  className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-60"
                  style={{ background: "#1A6B32", minHeight: 52 }}
                >
                  {saveMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
                  Épargner {saveAmount ? formatXOF(parseFloat(saveAmount)) : ""}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
