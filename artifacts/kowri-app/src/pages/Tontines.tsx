import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, ShoppingCart, Globe, Users, Loader2, ChevronRight, Tag, AlertCircle } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { TYPE_META, STATUS_META, FREQ_LABELS } from "@/lib/tontineTypes";

function friendlyName(name: string, type?: string): string {
  const raw = (name ?? "").trim();
  if (!raw || /^\d+$/.test(raw)) {
    return `Tontine ${TYPE_META[type ?? "classic"]?.label ?? "Classique"}`;
  }
  return raw.length > 20 ? raw.slice(0, 20) + "…" : raw;
}

function TypeBadge({ type }: { type: string }) {
  const meta = TYPE_META[type] ?? { label: type, colorClass: "bg-gray-100 text-gray-700", icon: "●" };
  const isHybrid = type === "hybrid";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${isHybrid ? "" : meta.colorClass}`}
      style={isHybrid ? { background: "linear-gradient(to right, #dcfce7, #dbeafe)", color: "#166534" } : undefined}
    >
      {meta.icon} {meta.label}
    </span>
  );
}

function ProgressRing({ current, total }: { current: number; total: number }) {
  const size = 48;
  const r    = 18;
  const circ = 2 * Math.PI * r;
  const safeTotal = Math.max(total, 1);
  const pct  = Math.min(1, current / safeTotal);
  return (
    <div className="relative flex-shrink-0">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E5E7EB" strokeWidth={5} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1A6B32" strokeWidth={5}
          strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} strokeLinecap="round" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-gray-700">
        {current}/{safeTotal}
      </span>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="bg-white rounded-2xl p-6 text-center border border-red-100 shadow-sm">
      <AlertCircle size={28} className="mx-auto mb-3" style={{ color: "#DC2626" }} />
      <p className="text-sm font-medium text-gray-700 mb-1">Impossible de charger</p>
      <p className="text-xs text-gray-400 mb-4">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 rounded-xl text-sm font-semibold text-white"
          style={{ background: "#1A6B32" }}
        >
          Réessayer
        </button>
      )}
    </div>
  );
}

function MesTontines() {
  const { token, user } = useAuth();

  const tontinesQ = useQuery({
    queryKey: ["tontines", user?.id],
    queryFn:  () => apiFetch<any>(`/tontines?userId=${user?.id}&limit=50`, token),
    enabled:  !!user?.id,
    staleTime: 20_000,
  });

  const tontines: any[] = Array.isArray(tontinesQ.data?.tontines)
    ? tontinesQ.data.tontines
    : [];

  if (tontinesQ.isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map(i => (
          <div key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 animate-pulse h-28" />
        ))}
      </div>
    );
  }

  if (tontinesQ.isError) {
    return (
      <ErrorCard
        message={(tontinesQ.error as any)?.message ?? "Erreur de chargement"}
        onRetry={() => tontinesQ.refetch()}
      />
    );
  }

  if (tontines.length === 0) {
    return (
      <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-gray-100">
        <div className="w-14 h-14 rounded-2xl mx-auto mb-4 flex items-center justify-center" style={{ background: "#F0FDF4" }}>
          <span className="text-2xl">🤝</span>
        </div>
        <p className="font-semibold text-gray-900 mb-1">Aucune tontine</p>
        <p className="text-sm text-gray-500 mb-5">Rejoignez une tontine ou créez la vôtre</p>
        <Link
          href="/tontines/create"
          className="inline-flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-white text-sm"
          style={{ background: "#1A6B32", minHeight: 44 }}
        >
          <Plus size={16} /> Nouvelle Tontine
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tontines.map((t: any) => {
        const status   = STATUS_META[t.status] ?? STATUS_META["pending"];
        const nextDate = t.nextPayoutDate
          ? new Date(t.nextPayoutDate).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })
          : null;
        return (
          <Link key={t.id} href={`/tontines/${t.id}`}>
            <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 active:bg-gray-50 cursor-pointer">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <TypeBadge type={t.tontineType ?? "classic"} />
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${status.colorClass}`}>{status.label}</span>
                  </div>
                  <h3 className="font-semibold text-gray-900 text-base leading-tight truncate">{friendlyName(t.name, t.tontineType)}</h3>
                </div>
                <ProgressRing current={t.currentRound ?? 0} total={t.totalRounds ?? t.maxMembers ?? 1} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold" style={{ color: "#1A6B32" }}>{formatXOF(t.contributionAmount)}</p>
                  <p className="text-xs text-gray-500">{FREQ_LABELS[t.frequency] ?? t.frequency}</p>
                </div>
                {nextDate && (
                  <div className="text-right">
                    <p className="text-xs text-gray-400">Prochain paiement</p>
                    <p className="text-xs font-semibold text-gray-700">{nextDate}</p>
                  </div>
                )}
                <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

const DISCOVER_FILTERS = [
  { value: "",           label: "Tous"          },
  { value: "classic",    label: "Classique"     },
  { value: "investment", label: "Investissement"},
  { value: "project",    label: "Projet"        },
  { value: "solidarity", label: "Solidarité"    },
  { value: "business",   label: "Business"      },
  { value: "hybrid",     label: "Hybride"       },
];

function Decouvrir() {
  const { token, user } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [joining, setJoining] = useState<string | null>(null);
  const [joinError, setJoinError] = useState("");

  const publicQ = useQuery({
    queryKey: ["tontines-public"],
    queryFn:  () => apiFetch<any>("/tontines/public", token),
    staleTime: 30_000,
  });

  const allTontines: any[] = Array.isArray(publicQ.data?.tontines) ? publicQ.data.tontines : [];
  const filtered = filter ? allTontines.filter((t: any) => t.tontineType === filter) : allTontines;

  const joinMut = useMutation({
    mutationFn: async (tontineId: string) => {
      setJoining(tontineId);
      return apiFetch<any>(`/community/tontines/${tontineId}/members`, token, {
        method: "POST",
        body: JSON.stringify({ userId: user?.id }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tontines-public"] });
      qc.invalidateQueries({ queryKey: ["tontines", user?.id] });
      setJoining(null);
      setJoinError("");
    },
    onError: (e: any) => { setJoining(null); setJoinError(e.message ?? "Erreur"); },
  });

  return (
    <div>
      <div className="flex gap-2 overflow-x-auto pb-3 -mx-4 px-4" style={{ scrollbarWidth: "none" }}>
        {DISCOVER_FILTERS.map(f => (
          <button
            key={f.value || "__all__"}
            onClick={() => setFilter(f.value)}
            className="flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all"
            style={{
              background: filter === f.value ? "#1A6B32" : "#FFFFFF",
              borderColor: filter === f.value ? "#1A6B32" : "#E5E7EB",
              color: filter === f.value ? "#FFFFFF" : "#6B7280",
              minHeight: 32,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {joinError && (
        <div className="mb-3 px-3 py-2 rounded-xl text-sm text-red-700 bg-red-50 flex items-center gap-2">
          <AlertCircle size={14} /> {joinError}
        </div>
      )}

      {publicQ.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map(i => <div key={i} className="bg-white rounded-2xl h-24 animate-pulse border border-gray-100" />)}
        </div>
      ) : publicQ.isError ? (
        <ErrorCard
          message={(publicQ.error as any)?.message ?? "Erreur de chargement"}
          onRetry={() => publicQ.refetch()}
        />
      ) : filtered.length === 0 ? (
        <div className="text-center py-10">
          <Globe size={32} className="mx-auto mb-3 text-gray-300" />
          <p className="text-gray-500 text-sm">Aucune tontine publique disponible</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((t: any) => (
            <div key={t.id} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
              <div className="flex items-start justify-between gap-2 mb-3">
                <div>
                  <TypeBadge type={t.tontineType ?? "classic"} />
                  <h3 className="font-semibold text-gray-900 mt-1 text-sm leading-tight">{friendlyName(t.name, t.tontineType)}</h3>
                </div>
                <button
                  onClick={() => joinMut.mutate(t.id)}
                  disabled={joining === t.id}
                  className="flex-shrink-0 px-3 py-2 rounded-xl text-xs font-bold text-white flex items-center gap-1 transition-opacity disabled:opacity-60"
                  style={{ background: "#1A6B32", minHeight: 36 }}
                >
                  {joining === t.id ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                  Rejoindre
                </button>
              </div>
              <div className="flex items-center gap-4 text-xs text-gray-500">
                <span className="flex items-center gap-1"><Users size={11} /> {t.memberCount ?? 0}/{t.maxMembers}</span>
                <span className="font-medium" style={{ color: "#1A6B32" }}>{formatXOF(t.contributionAmount)}</span>
                <span>{FREQ_LABELS[t.frequency] ?? t.frequency}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Marche() {
  const { token, user } = useAuth();
  const qc = useQueryClient();
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState("");

  const listingsQ = useQuery({
    queryKey: ["tontine-market"],
    queryFn:  () => apiFetch<any>("/community/tontines/positions", token),
    staleTime: 20_000,
  });

  const listings: any[] = Array.isArray(listingsQ.data?.listings) ? listingsQ.data.listings : [];

  const buyMut = useMutation({
    mutationFn: async (listingId: string) => {
      setBuying(listingId);
      return apiFetch<any>(`/community/tontines/positions/${listingId}/buy`, token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() } as any,
        body: JSON.stringify({ buyerId: user?.id }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tontine-market"] });
      qc.invalidateQueries({ queryKey: ["tontines", user?.id] });
      setBuying(null);
      setError("");
    },
    onError: (e: any) => { setBuying(null); setError(e.message ?? "Erreur lors de l'achat"); },
  });

  return (
    <div>
      {error && (
        <div className="mb-3 px-3 py-2 rounded-xl text-sm text-red-700 bg-red-50 flex items-center gap-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      <div style={{ display: listingsQ.isLoading ? "block" : "none" }} aria-hidden={!listingsQ.isLoading}>
        <div className="space-y-3">
          {[0, 1, 2].map(i => <div key={i} className="bg-white rounded-2xl h-20 animate-pulse border border-gray-100" />)}
        </div>
      </div>

      <div style={{ display: listingsQ.isError ? "block" : "none" }} aria-hidden={!listingsQ.isError}>
        <ErrorCard
          message={(listingsQ.error as any)?.message ?? "Erreur de chargement"}
          onRetry={() => listingsQ.refetch()}
        />
      </div>

      <div
        style={{ display: !listingsQ.isLoading && !listingsQ.isError && listings.length === 0 ? "block" : "none" }}
        aria-hidden={listingsQ.isLoading || listingsQ.isError || listings.length !== 0}
      >
        <div className="text-center py-10">
          <ShoppingCart size={32} className="mx-auto mb-3 text-gray-300" />
          <p className="text-gray-500 text-sm">Aucune position disponible sur le marché</p>
        </div>
      </div>

      <div
        style={{ display: !listingsQ.isLoading && !listingsQ.isError && listings.length > 0 ? "block" : "none" }}
        aria-hidden={listingsQ.isLoading || listingsQ.isError || listings.length === 0}
      >
        <div className="space-y-3">
          {listings.map((l: any) => (
            <div key={l.id} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Tag size={12} className="text-gray-400" />
                    <span className="text-sm font-semibold text-gray-900 truncate">{l.tontineName ?? "Tontine"}</span>
                  </div>
                  <p className="text-xs text-gray-500">Position #{l.payoutOrder}</p>
                  <p className="text-sm font-bold mt-1" style={{ color: "#1A6B32" }}>{formatXOF(l.askPrice)}</p>
                </div>
                <button
                  onClick={() => buyMut.mutate(l.id)}
                  disabled={buying === l.id}
                  className="flex-shrink-0 px-4 py-2 rounded-xl text-xs font-bold text-white flex items-center gap-1.5 disabled:opacity-60"
                  style={{ background: "#1A6B32", minHeight: 36 }}
                >
                  {buying === l.id ? <Loader2 size={12} className="animate-spin" /> : <ShoppingCart size={12} />}
                  Acheter
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type TabId = "mes" | "decouvrir" | "marche";

const TABS: { id: TabId; label: string }[] = [
  { id: "mes",       label: "Mes Tontines" },
  { id: "decouvrir", label: "Découvrir"    },
  { id: "marche",    label: "Marché"       },
];

export default function Tontines() {
  const [tab, setTab] = useState<TabId>("mes");

  return (
    <div className="min-h-screen pb-20" style={{ background: "#FAFAF8" }}>
      <TopBar title="Tontines" />

      <div className="sticky top-14 z-30 bg-white border-b border-gray-100 px-4">
        <div className="flex gap-1 max-w-lg mx-auto">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className="flex-1 py-3 text-xs font-semibold transition-all relative"
              style={{ color: tab === id ? "#1A6B32" : "#9CA3AF" }}
            >
              {label}
              {tab === id && (
                <span
                  className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full"
                  style={{ background: "#1A6B32" }}
                />
              )}
            </button>
          ))}
        </div>
      </div>

      <main className="px-4 pt-5 pb-4 max-w-lg mx-auto">
        {/* Each tab is a single div with stable key — prevents insertBefore crash */}
        <div key={`tab-${tab}`}>
          {tab === "mes" && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h1 className="text-xl font-bold text-gray-900">Mes Tontines</h1>
                <Link
                  href="/tontines/create"
                  className="flex items-center gap-2 px-3 py-2 rounded-xl font-semibold text-white text-sm"
                  style={{ background: "#1A6B32", minHeight: 40 }}
                >
                  <Plus size={15} /> Créer
                </Link>
              </div>
              <MesTontines />
            </div>
          )}

          {tab === "decouvrir" && (
            <div>
              <h1 className="text-xl font-bold text-gray-900 mb-4">Découvrir</h1>
              <Decouvrir />
            </div>
          )}

          {tab === "marche" && (
            <div>
              <h1 className="text-xl font-bold text-gray-900 mb-4">Marché Secondaire</h1>
              <Marche />
            </div>
          )}
        </div>
      </main>

      <BottomNav />
    </div>
  );
}
