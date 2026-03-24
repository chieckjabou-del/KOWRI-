import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  TrendingUp, Loader2, ChevronRight, X, CheckCircle2,
  BarChart3, AlertTriangle,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

const STATUS_FILTERS = ["Tous", "open", "active", "completed"] as const;
const STATUS_LABELS: Record<string, string> = {
  open: "Ouvert", active: "En cours", completed: "Complété", closed: "Clôturé",
};
const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  open:      { bg: "#F0FDF4", color: "#16A34A" },
  active:    { bg: "#EFF6FF", color: "#2563EB" },
  completed: { bg: "#F5F3FF", color: "#6D28D9" },
  closed:    { bg: "#F3F4F6", color: "#6B7280" },
};

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = Math.min(max > 0 ? (value / max) * 100 : 0, 100);
  return (
    <div className="h-2 rounded-full overflow-hidden" style={{ background: "#F3F4F6" }}>
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${pct}%`, background: "#1A6B32" }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.closed;
  return (
    <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: c.bg, color: c.color }}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function InvestModal({
  pool,
  walletId,
  walletBalance,
  userId,
  onClose,
}: {
  pool: any;
  walletId: string;
  walletBalance: number;
  userId: string;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<any>(null);

  const investMut = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(amount);
      if (!amt || amt <= 0) throw new Error("Montant invalide");
      if (amt < pool.minInvestment) throw new Error(`Minimum: ${formatXOF(pool.minInvestment)}`);
      if (amt > walletBalance) throw new Error("Solde insuffisant");
      return apiFetch<any>(`/pools/investment/${pool.id}/invest`, token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() } as any,
        body: JSON.stringify({ userId, amount: amt, walletId }),
      });
    },
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ["invest-pools"] });
    },
    onError: (err: any) => setError(err.message ?? "Investissement échoué"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div className="w-full bg-white rounded-t-3xl p-5 pb-10 max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-gray-900 text-base">{pool.name}</h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        {result ? (
          <div className="py-6 text-center space-y-3">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto" style={{ background: "#F0FDF4" }}>
              <CheckCircle2 size={32} style={{ color: "#1A6B32" }} />
            </div>
            <p className="font-bold text-gray-900">Investissement réussi !</p>
            <p className="text-sm text-gray-600">
              Vous avez investi <span className="font-semibold">{formatXOF(result.investedAmount ?? result.amount)}</span>
            </p>
            {result.shares != null && (
              <p className="text-xs text-gray-500">
                Parts reçues: <span className="font-medium">{Number(result.shares).toFixed(4)}</span>
                {" · "}NAV: <span className="font-medium">{formatXOF(result.nav ?? pool.nav ?? 1)}</span>
              </p>
            )}
            <button
              onClick={onClose}
              className="mt-4 px-6 py-3 rounded-xl font-bold text-white text-sm"
              style={{ background: "#1A6B32", minHeight: 44 }}
            >
              Fermer
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl p-3 border border-gray-100 space-y-1.5" style={{ background: "#F9FAFB" }}>
              <div className="flex justify-between text-xs text-gray-500">
                <span>Solde disponible</span>
                <span className="font-semibold text-gray-900">{formatXOF(walletBalance)}</span>
              </div>
              <div className="flex justify-between text-xs text-gray-500">
                <span>Investissement minimum</span>
                <span className="font-semibold text-gray-900">{formatXOF(pool.minInvestment)}</span>
              </div>
              <div className="flex justify-between text-xs text-gray-500">
                <span>Rendement attendu</span>
                <span className="font-semibold" style={{ color: "#1A6B32" }}>{pool.expectedReturn}%</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Montant à investir (XOF)
              </label>
              <input
                type="number"
                value={amount}
                onChange={e => { setAmount(e.target.value); setError(""); }}
                placeholder={`Min. ${formatXOF(pool.minInvestment)}`}
                inputMode="decimal"
                className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none"
                style={{ minHeight: 48 }}
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm" style={{ background: "#FEF2F2", color: "#DC2626" }}>
                <AlertTriangle size={14} className="flex-shrink-0" />
                {error}
              </div>
            )}

            <button
              onClick={() => investMut.mutate()}
              disabled={investMut.isPending || !amount}
              className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-70"
              style={{ background: "#1A6B32", minHeight: 52 }}
            >
              {investMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
              Investir maintenant
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Invest() {
  const { token, user } = useAuth();
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState("Tous");
  const [selectedPool, setSelectedPool] = useState<any>(null);

  const walletsQ = useQuery({
    queryKey: ["wallets", user?.id],
    queryFn: () => apiFetch<any>(`/wallets?userId=${user?.id}&limit=1`, token),
    enabled: !!user?.id,
  });
  const wallet = walletsQ.data?.wallets?.[0] ?? null;

  const poolsQ = useQuery({
    queryKey: ["invest-pools"],
    queryFn: () => apiFetch<any>("/pools/investment?limit=50", token),
    staleTime: 30_000,
  });

  const allPools: any[] = poolsQ.data?.pools ?? [];

  const filteredPools = filter === "Tous"
    ? allPools
    : allPools.filter(p => p.status === filter);

  const myPools = allPools.filter(p => {
    if (p.positions) return p.positions.some((pos: any) => pos.userId === user?.id);
    return false;
  });

  return (
    <div className="min-h-screen pb-24" style={{ background: "#FAFAF8" }}>
      <TopBar title="Investissement" />

      <main className="px-4 pt-4 pb-6 max-w-lg mx-auto space-y-5">

        {/* My Positions */}
        <section>
          <h2 className="font-bold text-gray-900 mb-3 text-base">Mes positions</h2>

          {poolsQ.isLoading ? (
            <div className="space-y-3">
              {[0, 1].map(i => (
                <div key={i} className="bg-white rounded-2xl h-28 animate-pulse border border-gray-100" />
              ))}
            </div>
          ) : myPools.length === 0 ? (
            <div className="bg-white rounded-2xl p-6 flex flex-col items-center text-center border border-gray-100">
              <div className="w-12 h-12 rounded-2xl mb-3 flex items-center justify-center" style={{ background: "#F0FDF4" }}>
                <BarChart3 size={24} style={{ color: "#1A6B32" }} />
              </div>
              <p className="font-semibold text-gray-700 text-sm">Vous n'avez pas encore investi</p>
              <p className="text-xs text-gray-400 mt-1">Découvrez nos pools ci-dessous</p>
            </div>
          ) : (
            <div className="space-y-3">
              {myPools.map(pool => {
                const myPos = pool.positions?.find((p: any) => p.userId === user?.id);
                const invested = Number(myPos?.investedAmount ?? 0);
                const shares = Number(myPos?.shares ?? 0);
                const nav = pool.nav ?? 1;
                const currentValue = shares * nav;
                const gain = currentValue - invested;
                return (
                  <div
                    key={pool.id}
                    className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm"
                    onClick={() => navigate(`/invest/${pool.id}`)}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <p className="font-bold text-gray-900 text-sm">{pool.name}</p>
                        <StatusBadge status={pool.status} />
                      </div>
                      <ChevronRight size={16} className="text-gray-400 mt-1" />
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
                      <div>
                        <p className="text-gray-400">Investi</p>
                        <p className="font-semibold text-gray-900">{formatXOF(invested)}</p>
                      </div>
                      <div>
                        <p className="text-gray-400">Valeur actuelle</p>
                        <p className="font-semibold text-gray-900">{formatXOF(currentValue)}</p>
                      </div>
                      <div>
                        <p className="text-gray-400">Gain/Perte</p>
                        <p className={`font-semibold ${gain >= 0 ? "text-green-600" : "text-red-500"}`}>
                          {gain >= 0 ? "+" : ""}{formatXOF(gain)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3">
                      <ProgressBar value={pool.currentAmount} max={pool.goalAmount} />
                      <p className="text-xs text-gray-400 mt-1">
                        {formatXOF(pool.currentAmount)} / {formatXOF(pool.goalAmount)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Discover Pools */}
        <section>
          <h2 className="font-bold text-gray-900 mb-3 text-base">Découvrir des pools</h2>

          {/* Filter pills */}
          <div className="flex gap-2 overflow-x-auto pb-2 mb-3 hide-scrollbar">
            {STATUS_FILTERS.map(f => {
              const active = filter === f;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className="flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all"
                  style={{
                    background: active ? "#1A6B32" : "#F3F4F6",
                    color: active ? "#fff" : "#6B7280",
                  }}
                >
                  {f === "Tous" ? "Tous" : STATUS_LABELS[f]}
                </button>
              );
            })}
          </div>

          {poolsQ.isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map(i => (
                <div key={i} className="bg-white rounded-2xl h-36 animate-pulse border border-gray-100" />
              ))}
            </div>
          ) : filteredPools.length === 0 ? (
            <div className="bg-white rounded-2xl p-6 text-center border border-gray-100">
              <p className="text-sm text-gray-500">Aucun pool disponible</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredPools.map(pool => (
                <div key={pool.id} className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1 min-w-0 mr-2">
                      <p className="font-bold text-gray-900 text-sm truncate">{pool.name}</p>
                      {pool.managerName && (
                        <p className="text-xs text-gray-400 mt-0.5">par {pool.managerName}</p>
                      )}
                    </div>
                    <StatusBadge status={pool.status} />
                  </div>

                  <div className="mt-3 mb-2">
                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                      <span>{formatXOF(pool.currentAmount)}</span>
                      <span className="text-gray-400">{formatXOF(pool.goalAmount)}</span>
                    </div>
                    <ProgressBar value={pool.currentAmount} max={pool.goalAmount} />
                  </div>

                  <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
                    <div>
                      <p className="text-gray-400">Rendement</p>
                      <p className="font-semibold" style={{ color: "#1A6B32" }}>{pool.expectedReturn}%</p>
                    </div>
                    <div>
                      <p className="text-gray-400">NAV</p>
                      <p className="font-semibold text-gray-900">{Number(pool.nav ?? 1).toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-gray-400">Min.</p>
                      <p className="font-semibold text-gray-900">{formatXOF(pool.minInvestment)}</p>
                    </div>
                  </div>

                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => navigate(`/invest/${pool.id}`)}
                      className="flex-1 py-2 rounded-xl text-xs font-semibold border"
                      style={{ borderColor: "#1A6B32", color: "#1A6B32", minHeight: 40 }}
                    >
                      Voir détails
                    </button>
                    {pool.status === "open" && (
                      <button
                        onClick={() => setSelectedPool(pool)}
                        className="flex-1 py-2 rounded-xl text-xs font-bold text-white"
                        style={{ background: "#1A6B32", minHeight: 40 }}
                      >
                        Investir
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      <BottomNav />

      {selectedPool && wallet && (
        <InvestModal
          pool={selectedPool}
          walletId={wallet.id}
          walletBalance={Number(wallet.availableBalance)}
          userId={user?.id ?? ""}
          onClose={() => setSelectedPool(null)}
        />
      )}
    </div>
  );
}
