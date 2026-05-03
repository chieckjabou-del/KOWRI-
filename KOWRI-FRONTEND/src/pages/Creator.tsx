import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Users, Star, Loader2, X, CheckCircle2, AlertTriangle, Plus,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? "")
    .join("");
}

function CreateCommunityModal({ userId, onClose, onCreated }: {
  userId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { token } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [description, setDescription] = useState("");
  const [creatorFee, setCreatorFee] = useState("5");
  const [error, setError] = useState("");

  const createMut = useMutation({
    mutationFn: () => {
      if (!name.trim() || !handle.trim()) throw new Error("Nom et identifiant requis");
      const h = handle.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (!h) throw new Error("Identifiant invalide (lettres, chiffres, _)");
      return apiFetch<any>("/creator/communities", token, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          handle: h,
          description: description.trim(),
          creatorId: userId,
          creatorFeeRate: parseFloat(creatorFee) / 100,
          platformFeeRate: 0.02,
        }),
      });
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["creator-communities"] });
      qc.invalidateQueries({ queryKey: ["creator-dashboard", userId] });
      onCreated(data.id ?? data.handle);
    },
    onError: (err: any) => setError(err.message ?? "Création échouée"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div className="w-full bg-white rounded-t-3xl p-5 pb-10 max-w-lg mx-auto max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-gray-900">Créer une communauté</h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Nom de la communauté</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Ex: Investisseurs Dakar"
              className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none"
              style={{ minHeight: 48 }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Identifiant (@unique)</label>
            <div className="flex items-center border border-gray-200 rounded-xl bg-gray-50 overflow-hidden" style={{ minHeight: 48 }}>
              <span className="pl-4 text-gray-400 text-sm font-medium">@</span>
              <input
                type="text"
                value={handle}
                onChange={e => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                placeholder="investdakar"
                className="flex-1 px-2 py-3 bg-transparent text-sm focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Décrivez votre communauté…"
              rows={3}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Commission créateur (%) — défaut 5%
            </label>
            <input
              type="number"
              value={creatorFee}
              onChange={e => setCreatorFee(e.target.value)}
              min="0"
              max="20"
              step="0.5"
              className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none"
              style={{ minHeight: 48 }}
            />
            <p className="text-xs text-gray-400 mt-1">Platform: 2% · Créateur: {creatorFee}% · Membres: {Math.max(0, 98 - parseFloat(creatorFee || "0"))}%</p>
          </div>

          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm" style={{ background: "#FEF2F2", color: "#DC2626" }}>
              <AlertTriangle size={14} />
              {error}
            </div>
          )}

          <button
            onClick={() => createMut.mutate()}
            disabled={createMut.isPending || !name || !handle}
            className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-70"
            style={{ background: "#1A6B32", minHeight: 52 }}
          >
            {createMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
            Créer la communauté
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Creator() {
  const { token, user } = useAuth();
  const [, navigate] = useLocation();
  const [showCreate, setShowCreate] = useState(false);
  const qc = useQueryClient();

  const communitiesQ = useQuery({
    queryKey: ["creator-communities"],
    queryFn: () => apiFetch<any>("/creator/communities?limit=30", token),
    staleTime: 30_000,
  });

  const dashboardQ = useQuery({
    queryKey: ["creator-dashboard", user?.id],
    queryFn: () => apiFetch<any>(`/creator/dashboard/${user?.id}`, token),
    enabled: !!user?.id,
    staleTime: 30_000,
    retry: false,
  });

  const joinMut = useMutation({
    mutationFn: (communityId: string) =>
      apiFetch<any>(`/creator/communities/${communityId}/join`, token, {
        method: "POST",
        body: JSON.stringify({ userId: user?.id }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["creator-communities"] });
    },
  });

  const communitiesSource = communitiesQ.data?.communities;
  const communities: any[] = Array.isArray(communitiesSource) ? communitiesSource : [];
  const dashboard = dashboardQ.data;

  return (
    <div className="min-h-screen pb-24" style={{ background: "#FAFAF8" }}>
      <TopBar title="Créateur" />

      <main className="px-4 pt-4 pb-6 max-w-lg mx-auto space-y-5">

        {/* My Community (if creator) */}
        {dashboard && (
          <section>
            <h2 className="font-bold text-gray-900 mb-3 text-base">Ma communauté</h2>
            <div
              className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm cursor-pointer"
              onClick={() => navigate(`/creator/${dashboard.id ?? dashboard.handle}`)}
            >
              <div className="flex items-center gap-3 mb-3">
                <div
                  className="w-12 h-12 rounded-2xl flex items-center justify-center font-bold text-white text-base flex-shrink-0"
                  style={{ background: "#1A6B32" }}
                >
                  {initials(dashboard.name ?? "C")}
                </div>
                <div>
                  <p className="font-bold text-gray-900">{dashboard.name}</p>
                  <p className="text-xs text-gray-400">@{dashboard.handle}</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-xl p-2.5 text-center" style={{ background: "#F0FDF4" }}>
                  <p className="text-gray-500">Membres</p>
                  <p className="font-bold text-gray-900">{dashboard.memberCount ?? 0}</p>
                </div>
                <div className="rounded-xl p-2.5 text-center" style={{ background: "#FFFBEB" }}>
                  <p className="text-gray-500">Gains</p>
                  <p className="font-bold" style={{ color: "#D97706" }}>{formatXOF(dashboard.totalEarnings ?? 0)}</p>
                </div>
                <div className="rounded-xl p-2.5 text-center" style={{ background: "#EFF6FF" }}>
                  <p className="text-gray-500">Commission</p>
                  <p className="font-bold text-blue-700">{((dashboard.creatorFeeRate ?? 0.05) * 100).toFixed(0)}%</p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Create Community CTA */}
        {!dashboard && !dashboardQ.isLoading && (
          <button
            onClick={() => setShowCreate(true)}
            className="w-full bg-white rounded-2xl p-4 border-2 border-dashed flex items-center gap-3 text-left"
            style={{ borderColor: "#1A6B32" }}
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "#F0FDF4" }}>
              <Plus size={20} style={{ color: "#1A6B32" }} />
            </div>
            <div>
              <p className="font-bold text-sm" style={{ color: "#1A6B32" }}>Créer une communauté</p>
              <p className="text-xs text-gray-400">Lancez votre espace et gagnez des commissions</p>
            </div>
          </button>
        )}

        {/* Discover Communities */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-gray-900 text-base">Découvrir</h2>
            {dashboard && (
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-xl"
                style={{ background: "#F0FDF4", color: "#1A6B32" }}
              >
                <Plus size={12} />
                Nouvelle
              </button>
            )}
          </div>

          {communitiesQ.isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map(i => (
                <div key={i} className="bg-white rounded-2xl h-28 animate-pulse border border-gray-100" />
              ))}
            </div>
          ) : communities.length === 0 ? (
            <div className="bg-white rounded-2xl p-6 text-center border border-gray-100">
              <p className="text-sm text-gray-500">Aucune communauté disponible</p>
              <button
                onClick={() => setShowCreate(true)}
                className="mt-3 px-5 py-2.5 rounded-xl font-bold text-white text-sm"
                style={{ background: "#1A6B32", minHeight: 44 }}
              >
                Créer la première
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {communities.map((community: any) => (
                <div
                  key={community.id}
                  className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm"
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-white text-sm flex-shrink-0"
                      style={{ background: "#1A6B32" }}
                    >
                      {initials(community.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="font-bold text-gray-900 text-sm truncate">{community.name}</p>
                      </div>
                      <p className="text-xs text-gray-400">@{community.handle}</p>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-gray-500 flex-shrink-0">
                      <Users size={12} />
                      {community.memberCount ?? 0}
                    </div>
                  </div>

                  {community.description && (
                    <p className="text-xs text-gray-500 mb-3 line-clamp-2">{community.description}</p>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={() => navigate(`/creator/${community.id}`)}
                      className="flex-1 py-2 rounded-xl text-xs font-semibold border"
                      style={{ borderColor: "#1A6B32", color: "#1A6B32", minHeight: 40 }}
                    >
                      Voir
                    </button>
                    {community.creatorId !== user?.id && (
                      <button
                        onClick={() => joinMut.mutate(community.id)}
                        disabled={joinMut.isPending}
                        className="flex-1 py-2 rounded-xl text-xs font-bold text-white flex items-center justify-center gap-1"
                        style={{ background: "#1A6B32", minHeight: 40 }}
                      >
                        {joinMut.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
                        Rejoindre
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

      {showCreate && (
        <CreateCommunityModal
          userId={user?.id ?? ""}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            navigate(`/creator/${id}`);
          }}
        />
      )}
    </div>
  );
}
