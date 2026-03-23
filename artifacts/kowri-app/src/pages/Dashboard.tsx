import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, Landmark } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { WalletCard } from "@/components/WalletCard";
import { TontineCard, TontineCardSkeleton } from "@/components/TontineCard";
import { TransactionRow, TransactionRowSkeleton } from "@/components/TransactionRow";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

export default function Dashboard() {
  const { token, user } = useAuth();

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

  const transactions = txQ.data?.transactions ?? [];
  const tontines     = tontinesQ.data?.tontines ?? [];

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
    </div>
  );
}
