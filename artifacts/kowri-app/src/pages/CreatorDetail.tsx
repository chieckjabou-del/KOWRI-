import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ChevronLeft, Users, Loader2, X, CheckCircle2, AlertTriangle,
  TrendingUp, DollarSign,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF } from "@/lib/api";

function EarningsModal({
  communityId,
  creatorFeeRate,
  onClose,
}: {
  communityId: string;
  creatorFeeRate: number;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<any>(null);

  const earningsMut = useMutation({
    mutationFn: () => {
      const amt = parseFloat(amount);
      if (!amt || amt <= 0) throw new Error("Montant invalide");
      return apiFetch<any>(`/creator/communities/${communityId}/earnings`, token, {
        method: "POST",
        body: JSON.stringify({ transactionAmount: amt, currency: "XOF" }),
      });
    },
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ["creator-dashboard"] });
    },
    onError: (err: any) => setError(err.message ?? "Enregistrement échoué"),
  });

  const amt = parseFloat(amount) || 0;
  const creatorShare  = amt * creatorFeeRate;
  const platformShare = amt * 0.02;
  const memberShare   = amt - creatorShare - platformShare;

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div className="w-full bg-white rounded-t-3xl p-5 pb-10 max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-gray-900">Enregistrer des gains</h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        {result ? (
          <div className="py-6 text-center space-y-3">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto" style={{ background: "#F0FDF4" }}>
              <CheckCircle2 size={32} style={{ color: "#1A6B32" }} />
            </div>
            <p className="font-bold text-gray-900">Gains distribués !</p>
            <div className="rounded-xl p-3 space-y-1.5 border border-gray-100 text-xs" style={{ background: "#F9FAFB" }}>
              {result.creatorShare != null && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Votre part (créateur)</span>
                  <span className="font-semibold text-green-700">{formatXOF(result.creatorShare)}</span>
                </div>
              )}
              {result.platformShare != null && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Plateforme</span>
                  <span className="font-semibold text-gray-700">{formatXOF(result.platformShare)}</span>
                </div>
              )}
            </div>
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
                Montant de la transaction (XOF)
              </label>
              <input
                type="number"
                value={amount}
                onChange={e => { setAmount(e.target.value); setError(""); }}
                placeholder="Ex: 50 000"
                inputMode="decimal"
                className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none"
                style={{ minHeight: 48 }}
              />
            </div>

            {amt > 0 && (
              <div className="rounded-xl p-3 border border-gray-100 space-y-2 text-xs" style={{ background: "#F9FAFB" }}>
                <div className="flex justify-between">
                  <span className="text-gray-500">Votre part ({(creatorFeeRate * 100).toFixed(0)}%)</span>
                  <span className="font-bold text-green-700">{formatXOF(creatorShare)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Membres ({(100 - creatorFeeRate * 100 - 2).toFixed(0)}%)</span>
                  <span className="font-semibold text-gray-700">{formatXOF(memberShare)}</span>
                </div>
                <div className="flex justify-between border-t border-gray-100 pt-2">
                  <span className="text-gray-500">Plateforme (2%)</span>
                  <span className="font-semibold text-gray-700">{formatXOF(platformShare)}</span>
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm" style={{ background: "#FEF2F2", color: "#DC2626" }}>
                <AlertTriangle size={14} />
                {error}
              </div>
            )}

            <button
              onClick={() => earningsMut.mutate()}
              disabled={earningsMut.isPending || !amount}
              className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-70"
              style={{ background: "#1A6B32", minHeight: 52 }}
            >
              {earningsMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
              Distribuer les gains
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CreatorDetail({ params }: { params?: { id?: string } }) {
  const { token, user } = useAuth();
  const [, navigate] = useLocation();
  const communityId = params?.id ?? "";
  const [showEarnings, setShowEarnings] = useState(false);

  const communityQ = useQuery({
    queryKey: ["creator-community-detail", communityId],
    queryFn: () => apiFetch<any>(`/creator/communities/${communityId}`, token),
    enabled: !!communityId,
    staleTime: 20_000,
    retry: false,
  });

  const poolsQ = useQuery({
    queryKey: ["creator-community-pools", communityId],
    queryFn: () => apiFetch<any>(`/creator/communities/${communityId}/pools`, token),
    enabled: !!communityId,
    staleTime: 20_000,
    retry: false,
  });

  const community = communityQ.data;
  const pools: any[] = poolsQ.data?.pools ?? poolsQ.data ?? [];
  const isCreator = community?.creatorId === user?.id;

  if (communityQ.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#FAFAF8" }}>
        <Loader2 size={28} className="animate-spin" style={{ color: "#1A6B32" }} />
      </div>
    );
  }

  if (!community) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6" style={{ background: "#FAFAF8" }}>
        <Users size={40} className="text-gray-300" />
        <p className="text-gray-500 text-sm">Communauté introuvable</p>
        <button
          onClick={() => navigate("/creator")}
          className="px-5 py-2.5 rounded-xl font-bold text-white text-sm"
          style={{ background: "#1A6B32" }}
        >
          Retour
        </button>
      </div>
    );
  }

  const creatorFeeRate = Number(community.creatorFeeRate ?? 0.05);

  return (
    <div className="min-h-screen pb-10" style={{ background: "#FAFAF8" }}>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-100">
        <div className="flex items-center gap-3 px-4 py-3 max-w-lg mx-auto">
          <button
            onClick={() => navigate("/creator")}
            className="p-2 -ml-2 rounded-full hover:bg-gray-100"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-gray-900 text-base truncate">{community.name}</h1>
            <p className="text-xs text-gray-400">@{community.handle}</p>
          </div>
          <div className="flex items-center gap-1 text-xs text-gray-500 flex-shrink-0">
            <Users size={12} />
            {community.memberCount ?? 0}
          </div>
        </div>
      </div>

      <main className="px-4 pt-4 pb-6 max-w-lg mx-auto space-y-4">

        {/* Info card */}
        <div className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
          <div className="grid grid-cols-3 gap-2 text-xs mb-3">
            <div className="rounded-xl p-2.5 text-center" style={{ background: "#F0FDF4" }}>
              <p className="text-gray-400">Membres</p>
              <p className="font-bold text-gray-900">{community.memberCount ?? 0}</p>
            </div>
            <div className="rounded-xl p-2.5 text-center" style={{ background: "#FFFBEB" }}>
              <p className="text-gray-400">Commission créateur</p>
              <p className="font-bold text-amber-700">{(creatorFeeRate * 100).toFixed(0)}%</p>
            </div>
            <div className="rounded-xl p-2.5 text-center" style={{ background: "#EFF6FF" }}>
              <p className="text-gray-400">Plateforme</p>
              <p className="font-bold text-blue-700">2%</p>
            </div>
          </div>

          {community.description && (
            <p className="text-sm text-gray-600 leading-relaxed">{community.description}</p>
          )}
        </div>

        {/* Creator actions */}
        {isCreator && (
          <button
            onClick={() => setShowEarnings(true)}
            className="w-full py-3.5 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2"
            style={{ background: "#1A6B32" }}
          >
            <DollarSign size={16} />
            Enregistrer des gains
          </button>
        )}

        {/* Linked pools */}
        <section>
          <h2 className="font-bold text-gray-900 mb-2 text-sm">Pools liés</h2>
          {poolsQ.isLoading ? (
            <div className="space-y-2">
              {[0, 1].map(i => <div key={i} className="bg-white rounded-xl h-14 animate-pulse border border-gray-100" />)}
            </div>
          ) : pools.length === 0 ? (
            <div className="bg-white rounded-2xl p-5 text-center border border-gray-100">
              <TrendingUp size={24} className="text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">Aucun pool associé à cette communauté</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden divide-y divide-gray-50">
              {pools.map((pool: any, idx: number) => (
                <div key={pool.id ?? idx} className="p-3 flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{pool.name}</p>
                    <p className="text-xs text-gray-400">{pool.type ?? pool.poolType ?? "Pool"}</p>
                  </div>
                  <div className="text-right text-xs flex-shrink-0">
                    {pool.goalAmount != null && (
                      <p className="font-semibold text-gray-900">{formatXOF(pool.goalAmount)}</p>
                    )}
                    <span
                      className="px-2 py-0.5 rounded-full font-medium"
                      style={pool.status === "active" || pool.status === "open"
                        ? { background: "#F0FDF4", color: "#16A34A" }
                        : { background: "#F3F4F6", color: "#6B7280" }
                      }
                    >
                      {pool.status ?? "—"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {showEarnings && (
        <EarningsModal
          communityId={communityId}
          creatorFeeRate={creatorFeeRate}
          onClose={() => setShowEarnings(false)}
        />
      )}
    </div>
  );
}
