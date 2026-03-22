import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Users, Calendar, TrendingUp, Loader2, ArrowLeft } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { useState } from "react";

const FREQ_LABELS: Record<string, string> = {
  weekly:   "Hebdomadaire",
  biweekly: "Bimensuel",
  monthly:  "Mensuel",
};

interface TontineDetailProps {
  params: { id: string };
}

export default function TontineDetail({ params }: TontineDetailProps) {
  const { id } = params;
  const { token, user } = useAuth();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [error, setError] = useState("");

  const tontineQ = useQuery({
    queryKey: ["tontine", id],
    queryFn: () => apiFetch<any>(`/tontines/${id}`, token),
    enabled: !!id,
  });

  const membersQ = useQuery({
    queryKey: ["tontine-members", id],
    queryFn: () => apiFetch<any>(`/tontines/${id}/members`, token),
    enabled: !!id,
  });

  const contributeMut = useMutation({
    mutationFn: async () => {
      return apiFetch<any>(`/tontines/${id}/contribute`, token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() } as any,
        body: JSON.stringify({ userId: user?.id }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tontine", id] });
      qc.invalidateQueries({ queryKey: ["wallets", user?.id] });
      setError("");
    },
    onError: (err: any) => setError(err.message ?? "Erreur lors de la cotisation"),
  });

  const tontine = tontineQ.data;
  const members = membersQ.data?.members ?? [];

  if (tontineQ.isLoading) {
    return (
      <div className="min-h-screen pb-20" style={{ background: "#FAFAF8" }}>
        <TopBar title="Tontine" showBack onBack={() => navigate("/tontines")} />
        <div className="px-4 pt-5 space-y-4 animate-pulse max-w-lg mx-auto">
          <div className="h-40 bg-white rounded-3xl shadow-sm" />
          <div className="h-32 bg-white rounded-2xl shadow-sm" />
        </div>
        <BottomNav />
      </div>
    );
  }

  if (!tontine || tontineQ.isError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center pb-20 px-6" style={{ background: "#FAFAF8" }}>
        <p className="text-gray-500 mb-4">Tontine introuvable</p>
        <button
          onClick={() => navigate("/tontines")}
          className="flex items-center gap-2 text-sm font-medium"
          style={{ color: "#1A6B32" }}
        >
          <ArrowLeft size={16} /> Retour
        </button>
        <BottomNav />
      </div>
    );
  }

  const rounds    = tontine.maxMembers ?? 1;
  const current   = tontine.currentRound ?? 0;
  const progress  = Math.min((current / rounds) * 100, 100);
  const poolTotal = parseFloat(tontine.contributionAmount) * (tontine.maxMembers ?? 1);
  const isMember  = members.some((m: any) => m.userId === user?.id);

  return (
    <div className="min-h-screen pb-20" style={{ background: "#FAFAF8" }}>
      <TopBar title={tontine.name} showBack onBack={() => navigate("/tontines")} />

      <main className="px-4 pt-5 pb-4 max-w-lg mx-auto space-y-4">
        {/* Header card */}
        <div
          className="rounded-3xl p-6 text-white shadow-lg"
          style={{ background: "linear-gradient(135deg, #1A6B32 0%, #2D9148 100%)" }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs px-2 py-0.5 rounded-full bg-white/20 font-medium capitalize">
              {tontine.status}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-white/20 font-medium">
              {FREQ_LABELS[tontine.frequency] ?? tontine.frequency}
            </span>
          </div>
          <h1 className="text-2xl font-black mt-2 mb-4">{tontine.name}</h1>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white/15 rounded-2xl p-3">
              <p className="text-xs opacity-70 mb-0.5">Cotisation</p>
              <p className="font-bold text-sm">{formatXOF(tontine.contributionAmount)}</p>
            </div>
            <div className="bg-white/15 rounded-2xl p-3">
              <p className="text-xs opacity-70 mb-0.5">Cagnotte du tour</p>
              <p className="font-bold text-sm">{formatXOF(poolTotal)}</p>
            </div>
          </div>
        </div>

        {/* Progress */}
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <TrendingUp size={16} style={{ color: "#1A6B32" }} />
              <span className="text-sm font-semibold text-gray-900">Progression</span>
            </div>
            <span className="text-sm font-medium text-gray-600">Tour {current}/{rounds}</span>
          </div>
          <div className="h-3 rounded-full overflow-hidden" style={{ background: "#F3F4F6" }}>
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${progress}%`, background: "#1A6B32" }}
            />
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3">
          <StatPill icon={<Users size={16} />} label="Membres" value={`${members.length}/${tontine.maxMembers}`} />
          <StatPill icon={<Calendar size={16} />} label="Prochain" value={
            tontine.nextPayoutAt
              ? new Date(tontine.nextPayoutAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })
              : "—"
          } />
          <StatPill icon={<TrendingUp size={16} />} label="Rang" value={
            isMember
              ? `#${(members.findIndex((m: any) => m.userId === user?.id) + 1)}`
              : "—"
          } />
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-3 rounded-xl text-sm font-medium" style={{ background: "#FEF2F2", color: "#DC2626" }}>
            {error}
          </div>
        )}

        {/* CTA */}
        {isMember && tontine.status === "active" && (
          <button
            onClick={() => contributeMut.mutate()}
            disabled={contributeMut.isPending}
            className="w-full py-4 rounded-2xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-70"
            style={{ background: "#1A6B32", minHeight: 52 }}
          >
            {contributeMut.isPending && <Loader2 size={16} className="animate-spin" />}
            Cotiser {formatXOF(tontine.contributionAmount)}
          </button>
        )}

        {/* Members list */}
        {members.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-50">
              <h2 className="font-semibold text-gray-900 text-sm">Membres</h2>
            </div>
            <ul className="divide-y divide-gray-50">
              {members.map((m: any, i: number) => (
                <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                    style={{ background: i === (current - 1) ? "#F59E0B" : "#1A6B32" }}
                  >
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {m.user?.firstName ?? "Membre"} {m.user?.lastName ?? ""}
                      {m.userId === user?.id && <span className="ml-1 text-xs text-gray-400">(Vous)</span>}
                    </p>
                    <p className="text-xs text-gray-500 capitalize">{m.status}</p>
                  </div>
                  {i === (current - 1) && (
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: "#FFFBEB", color: "#D97706" }}>
                      Bénéficiaire
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
}

function StatPill({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="bg-white rounded-2xl p-3 shadow-sm border border-gray-100 flex flex-col items-center gap-1 text-center">
      <div style={{ color: "#1A6B32" }}>{icon}</div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm font-bold text-gray-900">{value}</p>
    </div>
  );
}
