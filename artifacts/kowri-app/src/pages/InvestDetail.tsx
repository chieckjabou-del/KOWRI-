import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ChevronLeft, TrendingUp, Loader2, BarChart3, Users } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF } from "@/lib/api";
import { TopBar } from "@/components/TopBar";

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

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex-1 min-w-0 text-center">
      <p className="text-xs text-gray-400 mb-0.5">{label}</p>
      <p className="font-bold text-gray-900 text-sm">{value}</p>
      {sub && <p className="text-xs text-gray-400">{sub}</p>}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const letters = name
    .split(" ")
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
      style={{ background: "#1A6B32" }}
    >
      {letters}
    </div>
  );
}

export default function InvestDetail({ params }: { params?: { id?: string } }) {
  const { token, user } = useAuth();
  const [, navigate] = useLocation();
  const poolId = params?.id ?? "";

  const poolQ = useQuery({
    queryKey: ["invest-pool-detail", poolId],
    queryFn: () => apiFetch<any>(`/pools/investment/${poolId}`, token),
    enabled: !!poolId,
    staleTime: 20_000,
  });

  const pool = poolQ.data;
  const positions: any[] = pool?.positions ?? [];
  const myPosition = positions.find(p => p.userId === user?.id);
  const nav = Number(pool?.nav ?? 1);
  const sc = STATUS_COLORS[pool?.status] ?? STATUS_COLORS.closed;

  if (poolQ.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#FAFAF8" }}>
        <Loader2 size={28} className="animate-spin" style={{ color: "#1A6B32" }} />
      </div>
    );
  }

  if (!pool) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6" style={{ background: "#FAFAF8" }}>
        <BarChart3 size={40} className="text-gray-300" />
        <p className="text-gray-500 text-sm text-center">Pool introuvable</p>
        <button
          onClick={() => navigate("/invest")}
          className="px-5 py-2.5 rounded-xl font-bold text-white text-sm"
          style={{ background: "#1A6B32" }}
        >
          Retour
        </button>
      </div>
    );
  }

  const invested    = myPosition ? Number(myPosition.investedAmount) : 0;
  const shares      = myPosition ? Number(myPosition.shares) : 0;
  const currentVal  = shares * nav;
  const gain        = currentVal - invested;
  const progress    = pool.goalAmount > 0 ? Math.min((pool.currentAmount / pool.goalAmount) * 100, 100) : 0;

  return (
    <div className="min-h-screen pb-10" style={{ background: "#FAFAF8" }}>
      {/* Custom header */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-100">
        <div className="flex items-center gap-3 px-4 py-3 max-w-lg mx-auto">
          <button
            onClick={() => navigate("/invest")}
            className="p-2 -ml-2 rounded-full hover:bg-gray-100"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-gray-900 text-base truncate">{pool.name}</h1>
          </div>
          <span
            className="text-xs px-2.5 py-1 rounded-full font-semibold flex-shrink-0"
            style={{ background: sc.bg, color: sc.color }}
          >
            {STATUS_LABELS[pool.status] ?? pool.status}
          </span>
        </div>
      </div>

      <main className="px-4 pt-4 pb-6 max-w-lg mx-auto space-y-4">

        {/* Stats row */}
        <div className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
          <div className="flex divide-x divide-gray-100">
            <Stat label="Objectif" value={formatXOF(pool.goalAmount)} />
            <Stat label="Levé" value={formatXOF(pool.currentAmount)} />
            <Stat label="Investisseurs" value={String(positions.length)} />
            <Stat label="NAV" value={Number(nav).toFixed(3)} />
          </div>

          <div className="mt-4">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Progression</span>
              <span>{progress.toFixed(0)}%</span>
            </div>
            <ProgressBar value={pool.currentAmount} max={pool.goalAmount} />
          </div>

          <div className="grid grid-cols-2 gap-2 mt-4 text-xs">
            <div className="rounded-xl p-2.5" style={{ background: "#F0FDF4" }}>
              <p className="text-gray-500">Rendement attendu</p>
              <p className="font-bold" style={{ color: "#1A6B32" }}>{pool.expectedReturn}% / an</p>
            </div>
            <div className="rounded-xl p-2.5" style={{ background: "#FFFBEB" }}>
              <p className="text-gray-500">Investissement min.</p>
              <p className="font-bold text-amber-700">{formatXOF(pool.minInvestment)}</p>
            </div>
          </div>
        </div>

        {/* My position */}
        {myPosition && (
          <section>
            <h2 className="font-bold text-gray-900 mb-2 text-sm">Ma position</h2>
            <div className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl p-3 text-center" style={{ background: "#F9FAFB" }}>
                  <p className="text-gray-400 mb-1">Investi</p>
                  <p className="font-bold text-gray-900">{formatXOF(invested)}</p>
                </div>
                <div className="rounded-xl p-3 text-center" style={{ background: "#F9FAFB" }}>
                  <p className="text-gray-400 mb-1">Valeur actuelle</p>
                  <p className="font-bold text-gray-900">{formatXOF(currentVal)}</p>
                </div>
                <div className="rounded-xl p-3 text-center" style={{ background: gain >= 0 ? "#F0FDF4" : "#FEF2F2" }}>
                  <p className="text-gray-400 mb-1">Gain/Perte</p>
                  <p className={`font-bold ${gain >= 0 ? "text-green-600" : "text-red-500"}`}>
                    {gain >= 0 ? "+" : ""}{formatXOF(gain)}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex justify-between text-xs text-gray-500 px-1">
                <span>Parts: <span className="font-semibold text-gray-900">{shares.toFixed(4)}</span></span>
                <span>NAV: <span className="font-semibold text-gray-900">{nav.toFixed(3)}</span></span>
                {myPosition.joinedAt && (
                  <span>
                    Depuis: <span className="font-semibold text-gray-900">
                      {new Date(myPosition.joinedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}
                    </span>
                  </span>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Description */}
        {(pool.description || pool.managerId) && (
          <div className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
            {pool.description && (
              <p className="text-sm text-gray-600 leading-relaxed">{pool.description}</p>
            )}
            {pool.managerId && (
              <p className="text-xs text-gray-400 mt-2">
                Gérant: <span className="font-medium text-gray-700">{pool.managerName ?? pool.managerId}</span>
              </p>
            )}
          </div>
        )}

        {/* Investor positions */}
        {positions.length > 0 && (
          <section>
            <h2 className="font-bold text-gray-900 mb-2 text-sm">
              Investisseurs <span className="text-gray-400 font-normal">({positions.length})</span>
            </h2>
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden divide-y divide-gray-50">
              {positions.map((pos: any) => {
                const posShares = Number(pos.shares);
                const posValue  = posShares * nav;
                const name      = pos.userName ?? pos.userId?.slice(0, 8) ?? "Investisseur";
                const joinDate  = pos.joinedAt
                  ? new Date(pos.joinedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })
                  : "—";
                return (
                  <div key={pos.id} className="p-3 flex items-center gap-3">
                    <Avatar name={name} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{name}</p>
                      <p className="text-xs text-gray-400">Rejoint le {joinDate}</p>
                    </div>
                    <div className="text-right text-xs flex-shrink-0">
                      <p className="font-semibold text-gray-900">{formatXOF(Number(pos.investedAmount))}</p>
                      <p className="text-gray-400">{posShares.toFixed(4)} parts</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
