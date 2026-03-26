import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Shield, Loader2, X, CheckCircle2, AlertTriangle,
  Heart, Home, Users, Stethoscope,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

const TYPE_FILTERS = ["Tous", "health", "property", "solidarity", "general"] as const;
const TYPE_LABELS: Record<string, string> = {
  health: "Santé", property: "Biens", solidarity: "Solidarité", general: "Général",
};

const TYPE_ICONS: Record<string, React.ReactNode> = {
  health:     <Stethoscope size={18} style={{ color: "#DC2626" }} />,
  property:   <Home size={18} style={{ color: "#2563EB" }} />,
  solidarity: <Users size={18} style={{ color: "#D97706" }} />,
  general:    <Shield size={18} style={{ color: "#1A6B32" }} />,
};

const CLAIM_STATUS: Record<string, { label: string; bg: string; color: string }> = {
  under_review: { label: "En examen",  bg: "#FFFBEB", color: "#D97706" },
  approved:     { label: "Approuvé ✅", bg: "#F0FDF4", color: "#16A34A" },
  rejected:     { label: "Refusé",     bg: "#FEF2F2", color: "#DC2626" },
};

function ClaimModal({
  pool,
  policyId,
  userId,
  onClose,
}: {
  pool: any;
  policyId: string;
  userId: string;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const claimMut = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(amount);
      if (!amt || amt <= 0) throw new Error("Montant invalide");
      if (amt > pool.claimLimit) throw new Error(`Maximum: ${formatXOF(pool.claimLimit)}`);
      if (!reason.trim()) throw new Error("Veuillez décrire le sinistre");
      return apiFetch<any>(`/pools/insurance/${pool.id}/claims`, token, {
        method: "POST",
        body: JSON.stringify({ policyId, userId, claimAmount: amt, reason }),
      });
    },
    onSuccess: () => {
      setDone(true);
      qc.invalidateQueries({ queryKey: ["insurance-claims", pool.id] });
    },
    onError: (err: any) => setError(err.message ?? "Soumission échouée"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div className="w-full bg-white rounded-t-3xl p-5 pb-10 max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-gray-900">Déclarer un sinistre</h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        {done ? (
          <div className="py-6 text-center space-y-3">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto" style={{ background: "#F0FDF4" }}>
              <CheckCircle2 size={32} style={{ color: "#1A6B32" }} />
            </div>
            <p className="font-bold text-gray-900">Sinistre enregistré</p>
            <p className="text-sm text-gray-500">En cours d'examen — nous vous contacterons sous 48h</p>
            <button
              onClick={onClose}
              className="mt-2 px-6 py-3 rounded-xl font-bold text-white text-sm"
              style={{ background: "#1A6B32", minHeight: 44 }}
            >
              Fermer
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Montant réclamé (max. {formatXOF(pool.claimLimit)})
              </label>
              <input
                type="number"
                value={amount}
                onChange={e => { setAmount(e.target.value); setError(""); }}
                placeholder="Montant en XOF"
                inputMode="decimal"
                className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none"
                style={{ minHeight: 48 }}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Description du sinistre
              </label>
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Décrivez le sinistre en détail…"
                rows={3}
                className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none resize-none"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm" style={{ background: "#FEF2F2", color: "#DC2626" }}>
                <AlertTriangle size={14} />
                {error}
              </div>
            )}

            <button
              onClick={() => claimMut.mutate()}
              disabled={claimMut.isPending || !amount || !reason}
              className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-70"
              style={{ background: "#1A6B32", minHeight: 52 }}
            >
              {claimMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
              Soumettre le sinistre
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function JoinModal({
  pool,
  walletId,
  userId,
  onClose,
}: {
  pool: any;
  walletId: string;
  userId: string;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const qc = useQueryClient();
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const joinMut = useMutation({
    mutationFn: () =>
      apiFetch<any>(`/pools/insurance/${pool.id}/join`, token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() } as any,
        body: JSON.stringify({ userId, walletId }),
      }),
    onSuccess: () => {
      setDone(true);
      qc.invalidateQueries({ queryKey: ["insurance-pools"] });
      qc.invalidateQueries({ queryKey: ["insurance-policies", pool.id] });
    },
    onError: (err: any) => setError(err.message ?? "Adhésion échouée"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div className="w-full bg-white rounded-t-3xl p-5 pb-10 max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-gray-900">Rejoindre le pool</h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        {done ? (
          <div className="py-6 text-center space-y-3">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto" style={{ background: "#F0FDF4" }}>
              <CheckCircle2 size={32} style={{ color: "#1A6B32" }} />
            </div>
            <p className="font-bold text-gray-900">Vous êtes maintenant assuré !</p>
            <p className="text-sm text-gray-500">
              Prime : <span className="font-semibold">{formatXOF(pool.premiumAmount)}/mois</span>
            </p>
            <button
              onClick={onClose}
              className="mt-2 px-6 py-3 rounded-xl font-bold text-white text-sm"
              style={{ background: "#1A6B32", minHeight: 44 }}
            >
              Fermer
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl p-4 border border-gray-100 space-y-2.5" style={{ background: "#F9FAFB" }}>
              <div className="flex items-center gap-2 mb-1">
                {TYPE_ICONS[pool.insuranceType] ?? TYPE_ICONS.general}
                <span className="font-semibold text-gray-900">{pool.name}</span>
              </div>
              <Row label="Prime mensuelle" value={formatXOF(pool.premiumAmount)} />
              <Row label="Couverture maximale" value={formatXOF(pool.claimLimit)} />
              <Row label="Membres" value={`${pool.memberCount ?? "—"} / ${pool.maxMembers}`} />
              <Row label="Réserve" value={`${(pool.reserveRatio * 100).toFixed(0)}%`} />
            </div>

            {error && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm" style={{ background: "#FEF2F2", color: "#DC2626" }}>
                <AlertTriangle size={14} />
                {error}
              </div>
            )}

            <button
              onClick={() => joinMut.mutate()}
              disabled={joinMut.isPending}
              className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-70"
              style={{ background: "#1A6B32", minHeight: 52 }}
            >
              {joinMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
              Rejoindre — {formatXOF(pool.premiumAmount)}/mois
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Insurance() {
  const { token, user } = useAuth();
  const [filter, setFilter] = useState("Tous");
  const [claimTarget, setClaimTarget] = useState<{ pool: any; policyId: string } | null>(null);
  const [joinTarget, setJoinTarget] = useState<any>(null);

  const walletsQ = useQuery({
    queryKey: ["wallets", user?.id],
    queryFn: () => apiFetch<any>(`/wallets?userId=${user?.id}&limit=1`, token),
    enabled: !!user?.id,
  });
  const wallet = walletsQ.data?.wallets?.[0] ?? null;

  const poolsQ = useQuery({
    queryKey: ["insurance-pools"],
    queryFn: () => apiFetch<any>("/pools/insurance?limit=50", token),
    staleTime: 30_000,
  });

  const allPools: any[] = poolsQ.data?.pools ?? [];

  const filteredPools = filter === "Tous"
    ? allPools
    : allPools.filter(p => p.insuranceType === filter);

  /* My policies — fetch policies per pool; do a lightweight attempt */
  const myPoliciesQ = useQuery({
    queryKey: ["my-insurance-policies", user?.id],
    queryFn: async () => {
      const results: { policy: any; pool: any }[] = [];
      for (const pool of allPools.slice(0, 10)) {
        try {
          const data = await apiFetch<any>(`/pools/insurance/${pool.id}/policies`, token);
          const mine = (data.policies ?? []).filter((p: any) => p.userId === user?.id);
          mine.forEach((policy: any) => results.push({ policy, pool }));
        } catch { /* skip */ }
      }
      return results;
    },
    enabled: !!user?.id && allPools.length > 0,
    staleTime: 30_000,
  });

  const myPolicies = myPoliciesQ.data ?? [];

  return (
    <div className="min-h-screen pb-24" style={{ background: "#FAFAF8" }}>
      <TopBar title="Assurance" />

      <main className="px-4 pt-4 pb-6 max-w-lg mx-auto space-y-5">

        {/* My Policies */}
        <section>
          <h2 className="font-bold text-gray-900 mb-3 text-base">Mes polices</h2>
          {myPoliciesQ.isLoading ? (
            <div className="space-y-3">
              {[0, 1].map(i => (
                <div key={i} className="bg-white rounded-2xl h-28 animate-pulse border border-gray-100" />
              ))}
            </div>
          ) : myPolicies.length === 0 ? (
            <div className="bg-white rounded-2xl p-6 flex flex-col items-center text-center border border-gray-100">
              <div className="w-12 h-12 rounded-2xl mb-3 flex items-center justify-center" style={{ background: "#FEF3C7" }}>
                <Shield size={24} style={{ color: "#D97706" }} />
              </div>
              <p className="font-semibold text-gray-700 text-sm">Aucune police active</p>
              <p className="text-xs text-gray-400 mt-1">Rejoignez un pool d'assurance ci-dessous</p>
            </div>
          ) : (
            <div className="space-y-3">
              {myPolicies.map(({ policy, pool }) => {
                const isActive = policy.status === "active";
                const nextPayment = policy.nextPaymentDate
                  ? new Date(policy.nextPaymentDate).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })
                  : "—";
                return (
                  <div key={policy.id} className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <p className="font-bold text-gray-900 text-sm">{pool.name}</p>
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium mt-1 inline-block"
                          style={isActive
                            ? { background: "#F0FDF4", color: "#16A34A" }
                            : { background: "#F3F4F6", color: "#6B7280" }
                          }
                        >
                          {isActive ? "ACTIF" : "EXPIRÉ"}
                        </span>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-gray-400">Prime</p>
                        <p className="font-semibold text-sm text-gray-900">{formatXOF(pool.premiumAmount)}</p>
                      </div>
                    </div>

                    <div className="flex justify-between text-xs text-gray-500 mb-3">
                      <span>Couverture: <span className="font-medium text-gray-900">jusqu'à {formatXOF(pool.claimLimit)}</span></span>
                      <span>Prochain: <span className="font-medium text-gray-700">{nextPayment}</span></span>
                    </div>

                    {isActive && (
                      <button
                        onClick={() => setClaimTarget({ pool, policyId: policy.id })}
                        className="w-full py-2.5 rounded-xl text-xs font-semibold border-2"
                        style={{ borderColor: "#DC2626", color: "#DC2626", minHeight: 40 }}
                      >
                        Déclarer un sinistre
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Available Pools */}
        <section>
          <h2 className="font-bold text-gray-900 mb-3 text-base">Pools disponibles</h2>

          <div className="flex gap-2 overflow-x-auto pb-2 mb-3 hide-scrollbar">
            {TYPE_FILTERS.map(f => {
              const active = filter === f;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className="flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium"
                  style={{
                    background: active ? "#1A6B32" : "#F3F4F6",
                    color: active ? "#fff" : "#6B7280",
                  }}
                >
                  {f === "Tous" ? "Tous" : TYPE_LABELS[f]}
                </button>
              );
            })}
          </div>

          {poolsQ.isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map(i => (
                <div key={i} className="bg-white rounded-2xl h-40 animate-pulse border border-gray-100" />
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
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#F9FAFB" }}>
                      {TYPE_ICONS[pool.insuranceType] ?? TYPE_ICONS.general}
                    </div>
                    <div>
                      <p className="font-bold text-gray-900 text-sm">{pool.name}</p>
                      <p className="text-xs text-gray-400">{TYPE_LABELS[pool.insuranceType] ?? pool.insuranceType}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                    <div className="rounded-xl p-2.5" style={{ background: "#F9FAFB" }}>
                      <p className="text-gray-400 mb-0.5">Prime mensuelle</p>
                      <p className="font-bold text-gray-900">{formatXOF(pool.premiumAmount)}</p>
                    </div>
                    <div className="rounded-xl p-2.5" style={{ background: "#F9FAFB" }}>
                      <p className="text-gray-400 mb-0.5">Couverture max</p>
                      <p className="font-bold text-gray-900">{formatXOF(pool.claimLimit)}</p>
                    </div>
                    <div className="rounded-xl p-2.5" style={{ background: "#F9FAFB" }}>
                      <p className="text-gray-400 mb-0.5">Membres</p>
                      <p className="font-bold text-gray-900">{pool.memberCount ?? "—"} / {pool.maxMembers}</p>
                    </div>
                    <div className="rounded-xl p-2.5" style={{ background: "#F9FAFB" }}>
                      <p className="text-gray-400 mb-0.5">Réserve</p>
                      <p className="font-bold text-gray-900">{(pool.reserveRatio * 100).toFixed(0)}%</p>
                    </div>
                  </div>

                  <button
                    onClick={() => setJoinTarget(pool)}
                    className="w-full py-2.5 rounded-xl text-xs font-bold text-white"
                    style={{ background: "#1A6B32", minHeight: 40 }}
                  >
                    Rejoindre ce pool
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* My Claims */}
        {myPolicies.length > 0 && (
          <MyClaimsSection pools={myPolicies.map(mp => mp.pool)} userId={user?.id ?? ""} token={token} />
        )}
      </main>

      <BottomNav />

      {claimTarget && (
        <ClaimModal
          pool={claimTarget.pool}
          policyId={claimTarget.policyId}
          userId={user?.id ?? ""}
          onClose={() => setClaimTarget(null)}
        />
      )}

      {joinTarget && wallet && (
        <JoinModal
          pool={joinTarget}
          walletId={wallet.id}
          userId={user?.id ?? ""}
          onClose={() => setJoinTarget(null)}
        />
      )}
    </div>
  );
}

function MyClaimsSection({
  pools, userId, token,
}: {
  pools: any[]; userId: string; token: string | null;
}) {
  const allClaimsQ = useQuery({
    queryKey: ["my-all-claims", userId],
    queryFn: async () => {
      const results: any[] = [];
      for (const pool of pools.slice(0, 5)) {
        try {
          const data = await apiFetch<any>(`/pools/insurance/${pool.id}/claims`, token);
          const mine = (data.claims ?? []).filter((c: any) => c.userId === userId);
          mine.forEach((c: any) => results.push({ ...c, poolName: pool.name }));
        } catch { /* skip */ }
      }
      return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    },
    staleTime: 30_000,
  });

  const claims = allClaimsQ.data ?? [];
  const hidden = !claims.length && !allClaimsQ.isLoading;

  return (
    <section style={{ display: hidden ? "none" : undefined }}>
      <h2 className="font-bold text-gray-900 mb-3 text-base">Mes sinistres</h2>
      {allClaimsQ.isLoading ? (
        <div className="space-y-2">
          {[0, 1].map(i => <div key={i} className="bg-white rounded-xl h-14 animate-pulse border border-gray-100" />)}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden divide-y divide-gray-50">
          {claims.map((claim: any) => {
            const s = CLAIM_STATUS[claim.status] ?? CLAIM_STATUS.under_review;
            return (
              <div key={claim.id} className="p-3 flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">{formatXOF(claim.claimAmount)}</p>
                  <p className="text-xs text-gray-400 truncate">{claim.reason}</p>
                </div>
                <span className="text-xs px-2 py-1 rounded-full font-medium flex-shrink-0"
                  style={{ background: s.bg, color: s.color }}
                >
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-gray-500">{label}</span>
      <span className="font-semibold text-gray-900">{value}</span>
    </div>
  );
}
