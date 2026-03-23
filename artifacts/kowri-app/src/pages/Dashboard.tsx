import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, Landmark, PiggyBank, X, Loader2, CheckCircle2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { WalletCard } from "@/components/WalletCard";
import { TontineCard, TontineCardSkeleton } from "@/components/TontineCard";
import { TransactionRow, TransactionRowSkeleton } from "@/components/TransactionRow";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

const DURATIONS = [
  { days: 30,  label: "1 mois" },
  { days: 60,  label: "2 mois" },
  { days: 90,  label: "3 mois" },
  { days: 180, label: "6 mois" },
];

const INPUT_CLS = "w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none";

export default function Dashboard() {
  const { token, user } = useAuth();
  const qc = useQueryClient();

  /* Savings modal state */
  const [showSave,    setShowSave]    = useState(false);
  const [saveAmount,  setSaveAmount]  = useState("");
  const [saveDays,    setSaveDays]    = useState(90);
  const [planName,    setPlanName]    = useState("");
  const [saveUseNew,  setSaveUseNew]  = useState(true);
  const [saveError,   setSaveError]   = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);

  const walletsQ = useQuery({
    queryKey: ["wallets", user?.id],
    queryFn: () => apiFetch<any>(`/wallets?userId=${user?.id}&limit=1`, token),
    enabled: !!user?.id,
    staleTime: 10_000,
  });

  const wallet = walletsQ.data?.wallets?.[0] ?? null;

  const txQ = useQuery({
    queryKey: ["transactions", wallet?.id],
    queryFn: () => apiFetch<any>(`/transactions?walletId=${wallet?.id}&limit=5`, token),
    enabled: !!wallet?.id,
    staleTime: 10_000,
  });

  const tontinesQ = useQuery({
    queryKey: ["tontines", user?.id],
    queryFn: () => apiFetch<any>(`/tontines?userId=${user?.id}&limit=3`, token),
    enabled: !!user?.id,
    staleTime: 15_000,
  });

  /* Existing savings plans — only fetched when modal is open */
  const plansQ = useQuery({
    queryKey: ["savings-plans", user?.id],
    queryFn: () => apiFetch<any>(`/savings/plans?userId=${user?.id}`, token),
    enabled: !!user?.id && showSave,
    staleTime: 30_000,
  });
  const existingPlans: any[] = plansQ.data?.plans ?? [];
  const activePlans = existingPlans.filter((p: any) => p.status === "active");

  const transactions = txQ.data?.transactions ?? [];
  const tontines     = tontinesQ.data?.tontines ?? [];

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
          userId: user?.id,
          walletId: wallet.id,
          name,
          amount: parseFloat(saveAmount),
          currency: "XOF",
          termDays: saveDays,
        }),
      });
    },
    onSuccess: () => {
      setSaveSuccess(true);
      qc.invalidateQueries({ queryKey: ["wallets", user?.id] });
      qc.invalidateQueries({ queryKey: ["savings-plans", user?.id] });
    },
    onError: (e: any) => setSaveError(e.message ?? "Erreur"),
  });

  function openSaveModal() {
    setSaveAmount("");
    setSaveDays(90);
    setPlanName("");
    setSaveUseNew(true);
    setSaveError("");
    setSaveSuccess(false);
    setShowSave(true);
  }

  function closeSaveModal() {
    setShowSave(false);
    setSaveSuccess(false);
  }

  return (
    <div className="min-h-screen pb-20" style={{ background: "#FAFAF8" }}>
      <TopBar />

      <main className="px-4 pt-5 pb-4 max-w-lg mx-auto space-y-6">
        {/* Greeting */}
        <div>
          <p className="text-gray-500 text-sm">Bonjour,</p>
          <h1 className="text-2xl font-bold text-gray-900">
            {user?.firstName} {user?.lastName} 👋
          </h1>
        </div>

        {/* Wallet card */}
        {wallet ? (
          <WalletCard
            balance={wallet.balance}
            availableBalance={wallet.availableBalance}
            status={wallet.status}
            walletId={wallet.id}
          />
        ) : walletsQ.isLoading ? (
          <WalletCard balance={0} availableBalance={0} status="active" walletId="" isLoading />
        ) : (
          <div className="rounded-3xl p-6 bg-white border border-gray-100 text-center text-gray-500 text-sm shadow-sm">
            Aucun wallet trouvé.{" "}
            <span style={{ color: "#1A6B32" }} className="font-medium">Créer mon wallet</span>
          </div>
        )}

        {/* Quick actions row */}
        {wallet ? (
          <div className="grid grid-cols-2 gap-3">
            <Link href="/diaspora">
              <button
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl text-sm font-semibold border border-gray-200 bg-white shadow-sm"
                style={{ minHeight: 48 }}
              >
                <Landmark size={16} className="text-gray-500" />
                <span className="text-gray-700">Diaspora</span>
              </button>
            </Link>
            <button
              onClick={openSaveModal}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl text-sm font-semibold text-white shadow-sm"
              style={{ background: "linear-gradient(135deg, #1A6B32 0%, #2D9148 100%)", minHeight: 48 }}
            >
              <PiggyBank size={16} />
              Épargner
            </button>
          </div>
        ) : null}

        {/* Tontines */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-gray-900 text-base">Mes Tontines</h2>
            <Link href="/tontines">
              <span className="text-sm font-medium" style={{ color: "#1A6B32" }}>Voir tout</span>
            </Link>
          </div>

          <div className="space-y-3">
            {tontinesQ.isLoading ? (
              [0,1].map(i => <TontineCardSkeleton key={i} />)
            ) : tontines.length === 0 ? (
              <div className="bg-white rounded-2xl p-6 text-center shadow-sm border border-gray-100">
                <p className="text-gray-500 text-sm mb-4">
                  Rejoignez une tontine ou créez la vôtre
                </p>
                <Link href="/tontines">
                  <button
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-white text-sm"
                    style={{ background: "#1A6B32", minHeight: 44 }}
                  >
                    <Plus size={16} />
                    Nouvelle Tontine
                  </button>
                </Link>
              </div>
            ) : (
              tontines.map((t: any) => (
                <TontineCard key={t.id} id={t.id} name={t.name}
                  contributionAmount={t.contributionAmount} frequency={t.frequency}
                  maxMembers={t.maxMembers} status={t.status}
                  currentRound={t.currentRound} totalRounds={t.maxMembers}
                  nextPayoutAt={t.nextPayoutAt} memberCount={t.memberCount}
                  compact
                />
              ))
            )}
          </div>
        </section>

        {/* Recent transactions */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-gray-900 text-base">Transactions récentes</h2>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 divide-y divide-gray-50 px-4">
            {txQ.isLoading ? (
              [0,1,2].map(i => <TransactionRowSkeleton key={i} />)
            ) : transactions.length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-sm">
                Aucune transaction récente
              </div>
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
      </main>

      <BottomNav />

      {/* ─── Savings modal ──────────────────────────────────────────────── */}
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
                <button
                  onClick={closeSaveModal}
                  className="w-full py-4 rounded-xl font-bold text-white text-sm"
                  style={{ background: "#1A6B32", minHeight: 52 }}
                >
                  Fermer
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                {/* Plan type selector */}
                {activePlans.length > 0 ? (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setSaveUseNew(true)}
                      className="py-3 rounded-xl text-xs font-semibold border transition-all"
                      style={{
                        background: saveUseNew ? "#F0FDF4" : "#F9FAFB",
                        borderColor: saveUseNew ? "#1A6B32" : "#E5E7EB",
                        color: saveUseNew ? "#1A6B32" : "#6B7280",
                        minHeight: 44,
                      }}
                    >
                      Nouveau plan
                    </button>
                    <button
                      onClick={() => setSaveUseNew(false)}
                      className="py-3 rounded-xl text-xs font-semibold border transition-all"
                      style={{
                        background: !saveUseNew ? "#F0FDF4" : "#F9FAFB",
                        borderColor: !saveUseNew ? "#1A6B32" : "#E5E7EB",
                        color: !saveUseNew ? "#1A6B32" : "#6B7280",
                        minHeight: 44,
                      }}
                    >
                      Plan existant ({activePlans.length})
                    </button>
                  </div>
                ) : null}

                {/* Amount */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Montant (XOF)</label>
                  <div className="relative">
                    <input
                      type="number"
                      value={saveAmount}
                      onChange={e => setSaveAmount(e.target.value)}
                      placeholder="Ex: 50 000"
                      inputMode="decimal"
                      className={INPUT_CLS}
                      style={{ minHeight: 52, paddingRight: 56 }}
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-medium text-gray-400">XOF</span>
                  </div>
                  {wallet ? (
                    <p className="text-xs text-gray-400 mt-1">
                      Disponible : {formatXOF(wallet.availableBalance)}
                    </p>
                  ) : null}
                </div>

                {/* New plan: name + duration */}
                {saveUseNew ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Nom du plan (optionnel)</label>
                      <input
                        type="text"
                        value={planName}
                        onChange={e => setPlanName(e.target.value)}
                        placeholder="Ex: Fonds de voyage"
                        className={INPUT_CLS}
                        style={{ minHeight: 48 }}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Durée</label>
                      <div className="grid grid-cols-4 gap-2">
                        {DURATIONS.map(({ days, label }) => (
                          <button
                            key={days}
                            onClick={() => setSaveDays(days)}
                            className="py-3 rounded-xl text-xs font-semibold border transition-all"
                            style={{
                              background: saveDays === days ? "#F0FDF4" : "#F9FAFB",
                              borderColor: saveDays === days ? "#1A6B32" : "#E5E7EB",
                              color: saveDays === days ? "#1A6B32" : "#6B7280",
                              minHeight: 44,
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Rate info */}
                    <div className="rounded-xl p-3" style={{ background: "#F0FDF4", border: "1px solid #BBF7D0" }}>
                      <p className="text-xs font-semibold text-green-800 mb-1">💡 Plan à terme fixe</p>
                      <p className="text-xs text-green-700">
                        Vos fonds seront verrouillés pendant {saveDays} jours. Un taux d'intérêt est appliqué selon votre profil.
                      </p>
                    </div>
                  </>
                ) : (
                  /* Existing plans list */
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-700">Ajouter à un plan existant</label>
                    {activePlans.map((p: any) => {
                      const maturity = new Date(p.maturityDate);
                      const daysLeft = Math.max(0, Math.round((maturity.getTime() - Date.now()) / 86_400_000));
                      return (
                        <div key={p.id} className="rounded-xl border border-gray-100 p-3 bg-gray-50">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-semibold text-gray-900">{p.name}</p>
                            <span className="text-xs text-green-700 font-semibold">{daysLeft}j restants</span>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Verrouillé : {formatXOF(p.lockedAmount)}
                          </p>
                        </div>
                      );
                    })}
                    <p className="text-xs text-gray-400">
                      Note : une nouvelle épargne sera créée dans ce wallet.
                    </p>
                  </div>
                )}

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
