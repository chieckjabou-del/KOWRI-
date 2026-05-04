import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { ArrowRight, CheckCircle2, CircleHelp, Loader2, Plus, Search, Sparkles, Users } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { formatXOF } from "@/lib/api";
import {
  createTontine,
  joinTontine,
  listPublicTontines,
  listUserTontines,
  searchPublicTontines,
} from "@/services/api/tontineService";
import { getCreatorDashboard, saveCreatorModeLink } from "@/services/api/creatorService";
import type { RotationModel, TontineFrequency, TontineListItem } from "@/types/akwe";
import { useToast } from "@/hooks/use-toast";
import { EmptyHint, ScreenContainer, SectionIntro, SkeletonCard } from "@/components/premium/PremiumStates";
import { getCached, setCached } from "@/lib/localCache";
import { useSmartWarmup } from "@/hooks/useSmartWarmup";
import { DATA_TTL_MS, invalidateCacheByMutation } from "@/lib/cachePolicy";
import { trackUxAction } from "@/lib/frontendMonitor";

const FREQUENCIES: TontineFrequency[] = ["weekly", "biweekly", "monthly"];
const FREQ_LABEL: Record<TontineFrequency, string> = {
  weekly: "Hebdo",
  biweekly: "Bimensuel",
  monthly: "Mensuel",
};

const TONTINE_CACHE_TTL_MS = DATA_TTL_MS.TONTINE_LIST;
const TONTINE_PUBLIC_CACHE_TTL_MS = DATA_TTL_MS.TONTINE_PUBLIC;

export default function TontineHome() {
  const { token, user } = useAuth();
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [showExplorer, setShowExplorer] = useState(false);
  const [showFlexibleInfo, setShowFlexibleInfo] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("50000");
  const [maxMembers, setMaxMembers] = useState("10");
  const [frequency, setFrequency] = useState<TontineFrequency>("monthly");
  const [tontineType, setTontineType] = useState<"classic" | "solidarity" | "project">("classic");
  const [rotationMode, setRotationMode] = useState<RotationModel>("fixed");
  const [isCustomContribution, setIsCustomContribution] = useState(false);
  const [creatorModeEnabled, setCreatorModeEnabled] = useState(false);
  const [creatorCommunityId, setCreatorCommunityId] = useState("");
  const [customRows, setCustomRows] = useState<Array<{ userId: string; amount: string }>>([
    { userId: "", amount: "" },
  ]);
  const [createError, setCreateError] = useState("");
  useSmartWarmup([
    {
      queryKey: ["akwe-public-tontines"],
      queryFn: () => listPublicTontines(token),
    },
    {
      queryKey: ["akwe-tontines", user?.id],
      queryFn: () => listUserTontines(token),
    },
  ], Boolean(token && user?.id));
  const urlSearch = useMemo(() => {
    const queryString =
      typeof window !== "undefined"
        ? window.location.search
        : location.includes("?")
          ? location.slice(location.indexOf("?"))
          : "";
    return new URLSearchParams(queryString);
  }, [location]);
  const isDemoFlow = urlSearch.get("demo") === "1";

  const userTontinesQuery = useQuery({
    queryKey: ["akwe-tontines", user?.id],
    enabled: Boolean(user?.id),
    staleTime: TONTINE_CACHE_TTL_MS,
    initialData: user?.id
      ? () => getCached<{ tontines: TontineListItem[]; usingMock: boolean }>(`cache:tontines:mine:${user.id}`)
      : undefined,
    queryFn: () => listUserTontines(token),
  });

  useEffect(() => {
    if (!user?.id || !userTontinesQuery.data) return;
    setCached(`cache:tontines:mine:${user.id}`, userTontinesQuery.data, TONTINE_CACHE_TTL_MS);
  }, [user?.id, userTontinesQuery.data]);

  const publicTontinesQuery = useQuery({
    queryKey: ["akwe-public-tontines"],
    enabled: Boolean(user?.id),
    staleTime: TONTINE_PUBLIC_CACHE_TTL_MS,
    initialData: () =>
      getCached<{ tontines: TontineListItem[]; usingMock: boolean }>("cache:tontines:public"),
    queryFn: () => listPublicTontines(token),
  });

  useEffect(() => {
    if (!publicTontinesQuery.data) return;
    setCached("cache:tontines:public", publicTontinesQuery.data, TONTINE_PUBLIC_CACHE_TTL_MS);
  }, [publicTontinesQuery.data]);

  const creatorDashboardQuery = useQuery({
    queryKey: ["akwe-tontine-create-creator-dashboard", user?.id],
    enabled: Boolean(showCreate && user?.id),
    queryFn: () => getCreatorDashboard(token, user!.id),
    retry: false,
  });
  const creatorCommunities = creatorDashboardQuery.data?.dashboard.communities ?? [];

  useEffect(() => {
    if (!creatorModeEnabled) return;
    if (!creatorCommunityId && creatorCommunities.length > 0) {
      setCreatorCommunityId(creatorCommunities[0].id);
    }
  }, [creatorModeEnabled, creatorCommunityId, creatorCommunities]);

  useEffect(() => {
    if (!showCreate && (urlSearch.get("create") === "1" || isDemoFlow)) {
      setShowCreate(true);
    }
    if (urlSearch.get("creator") === "1") {
      setCreatorModeEnabled(true);
    }
  }, [showCreate, urlSearch, isDemoFlow]);

  const myTontines = userTontinesQuery.data?.tontines ?? [];
  const discoverTontines = useMemo(() => {
    const ownIds = new Set(myTontines.map((item) => item.id));
    return (publicTontinesQuery.data?.tontines ?? []).filter((item) => !ownIds.has(item.id));
  }, [myTontines, publicTontinesQuery.data?.tontines]);

  const usingMock = Boolean(userTontinesQuery.data?.usingMock || publicTontinesQuery.data?.usingMock);

  const joinMutation = useMutation({
    mutationFn: async (tontineId: string) => {
      if (!user) return;
      await joinTontine(token, tontineId, user.id);
    },
    onSuccess: async () => {
      invalidateCacheByMutation("join", user?.id ?? null);
      trackUxAction("tontine.join.success", { userId: user?.id ?? "anon" });
      await queryClient.invalidateQueries({ queryKey: ["akwe-tontines", user?.id] });
      await queryClient.invalidateQueries({ queryKey: ["akwe-public-tontines"] });
      toast({
        title: "Demande envoyee",
        description: "Tu viens de rejoindre la tontine. Mise a jour en cours.",
      });
    },
    onError: (error: unknown) => {
      toast({
        variant: "destructive",
        title: "Impossible de rejoindre",
        description: error instanceof Error ? error.message : "Reessaie dans un instant.",
      });
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!user) return { tontineId: "", usingMock: false };
      const payloadName = name.trim() || "Nouvelle tontine";
      const customContributions = customRows
        .map((row) => ({ userId: row.userId.trim(), personalContribution: Number(row.amount) }))
        .filter((row) => row.userId && Number.isFinite(row.personalContribution) && row.personalContribution > 0);
      const effectiveType = tontineType === "solidarity" ? "classic" : tontineType;
      return createTontine(token, user.id, {
        name: payloadName,
        contributionAmount: Number(amount),
        maxMembers: Number(maxMembers),
        frequency,
        tontineType: effectiveType,
        isPublic: true,
        isMultiAmount: isCustomContribution,
        rotationModel: rotationMode,
        isFlexibleOrder: rotationMode !== "fixed",
        customContributions,
      });
    },
    onSuccess: async (result) => {
      trackUxAction("tontine.create.success", {
        userId: user?.id ?? "anon",
        creatorModeEnabled,
      });
      const selectedCommunity = creatorCommunities.find(
        (community) => community.id === creatorCommunityId,
      );
      if (creatorModeEnabled && result.tontineId && selectedCommunity) {
        saveCreatorModeLink(result.tontineId, {
          communityId: selectedCommunity.id,
          creatorFeeRate: selectedCommunity.creatorFeeRate,
          communityName: selectedCommunity.name,
        });
      }
      setShowCreate(false);
      setName("");
      setCustomRows([{ userId: "", amount: "" }]);
      setIsCustomContribution(false);
      setCreatorModeEnabled(false);
      setCreatorCommunityId("");
      invalidateCacheByMutation("create-tontine", user?.id ?? null);
      await queryClient.invalidateQueries({ queryKey: ["akwe-tontines", user?.id] });
      await queryClient.invalidateQueries({ queryKey: ["akwe-public-tontines"] });
      toast({
        title: "Tontine creee",
        description:
          creatorModeEnabled && selectedCommunity
            ? `Mode createur active avec ${selectedCommunity.name}: ${selectedCommunity.creatorFeeRate.toFixed(0)}% sur chaque contribution collecte.`
            : "Ta tontine est visible. Tu peux inviter ou suivre les tours.",
      });
      if (result.tontineId) {
        navigate(
          isDemoFlow
            ? `/tontine/${result.tontineId}?demo=1`
            : `/tontine/${result.tontineId}`,
        );
      }
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Creation impossible";
      setCreateError(message);
      toast({ variant: "destructive", title: "Creation bloquee", description: message });
    },
  });

  function handleCreate() {
    setCreateError("");
    const amountValue = Number(amount);
    const membersValue = Number(maxMembers);

    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      setCreateError("Le montant de cotisation doit etre superieur a 0.");
      return;
    }
    if (!Number.isFinite(membersValue) || membersValue < 2) {
      setCreateError("Le nombre de membres doit etre superieur ou egal a 2.");
      return;
    }
    if (!Number.isInteger(membersValue)) {
      setCreateError("Le nombre de membres doit etre un entier.");
      return;
    }
    if (creatorModeEnabled && !creatorCommunityId) {
      setCreateError("Active d'abord une communaute createur pour continuer.");
      return;
    }
    if (isCustomContribution) {
      const hasInvalidRow = customRows.some((row) => {
        if (!row.userId.trim() && !row.amount.trim()) return false;
        const parsed = Number(row.amount);
        return !row.userId.trim() || !Number.isFinite(parsed) || parsed <= 0;
      });
      if (hasInvalidRow) {
        setCreateError("Verifie la liste des cotisations personnalisees avant de continuer.");
        return;
      }

      if (customRows.length > 1) {
        toast({
          title: "Info backend conservee",
          description:
            "Les montants personnalises seront ajustes apres creation. La creation part bien avec is_multi_amount=true.",
        });
      }
    }

    createMutation.mutate();
  }

  return (
    <div className="min-h-screen bg-[#fcfcfb] pb-24">
      <TopBar title="Tontine" />
      <ScreenContainer>
        <SectionIntro
          title="Lance ta tontine sans friction"
          subtitle="Creer, rejoindre et piloter une tontine premium avec une lecture claire des tours."
          actions={
            <Button variant="outline" className="press-feedback rounded-xl" onClick={() => setShowExplorer(true)}>
              <Search className="h-4 w-4" />
              Explorer
            </Button>
          }
        />

        {usingMock && (
          <div className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
            Mode simulation active: fallback visuel active pour garantir la demo.
          </div>
        )}

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold">Mes tontines</CardTitle>
            <Button
              className="press-feedback rounded-xl bg-black text-white hover:bg-black/90"
              onClick={() => setShowCreate(true)}
            >
              <Plus className="h-4 w-4" />
              Lancer en 30s
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {userTontinesQuery.isLoading ? (
              <SkeletonCard rows={4} className="bg-transparent px-0 py-0 shadow-none border-none" />
            ) : myTontines.length === 0 ? (
              <EmptyHint
                title="Aucune tontine active"
                description="Lance la tienne pour demarrer un cycle clair et attirer tes membres."
                action={
                  <Button className="press-feedback rounded-xl bg-black text-white hover:bg-black/90" onClick={() => setShowCreate(true)}>
                    Creer maintenant
                  </Button>
                }
              />
            ) : (
              myTontines.map((item, index) => (
                <Link key={item.id} href={`/tontine/${item.id}`}>
                  <div
                    className="premium-hover cursor-pointer rounded-2xl border border-gray-100 bg-white px-4 py-4 transition hover:border-black/15"
                    style={{
                      animation: "premium-page-enter 320ms cubic-bezier(0.16, 1, 0.3, 1)",
                      animationDelay: `${Math.min(index * 45, 220)}ms`,
                      animationFillMode: "both",
                    }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-black">{item.name}</p>
                        <p className="mt-1 text-xs text-gray-500">
                          {formatXOF(item.contributionAmount)} - {item.memberCount}/{item.maxMembers} membres
                        </p>
                      </div>
                      <div className="flex items-center gap-2 text-xs font-medium text-gray-500">
                        {FREQ_LABEL[item.frequency]}
                        <ArrowRight className="h-4 w-4" />
                      </div>
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-700">
                        {item.tontineType}
                      </span>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-700">
                        Tour {item.currentRound}/{item.totalRounds}
                      </span>
                    </div>
                    <div className="mt-3 h-1.5 rounded-full bg-gray-100">
                      <div
                        className="h-1.5 rounded-full bg-black"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.round((item.currentRound / Math.max(item.totalRounds, 1)) * 100),
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base font-semibold">Trouver une tontine pres de toi</CardTitle>
              <Button variant="outline" className="press-feedback rounded-xl" onClick={() => setShowExplorer(true)}>
                <Search className="h-4 w-4" />
                Explorer
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {publicTontinesQuery.isLoading ? (
              <SkeletonCard rows={3} className="bg-transparent px-0 py-0 shadow-none border-none" />
            ) : discoverTontines.length === 0 ? (
              <EmptyHint
                title="Aucune tontine publique"
                description="Aucune opportunite visible maintenant. Utilise Explorer pour filtrer plus finement."
              />
            ) : (
              discoverTontines.slice(0, 6).map((item) => (
                <div key={item.id} className="premium-hover rounded-2xl border border-gray-100 bg-white px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-black">{item.name}</p>
                      <p className="mt-1 text-xs text-gray-500">
                        {formatXOF(item.contributionAmount)} - {FREQ_LABEL[item.frequency]}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-700">
                          {item.tontineType}
                        </span>
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-700">
                          {item.maxMembers} membres max
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      className="press-feedback rounded-xl"
                      onClick={() => joinMutation.mutate(item.id)}
                      disabled={joinMutation.isPending}
                    >
                      {joinMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Rejoindre
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <section className="grid gap-3 sm:grid-cols-2">
          <Card className="premium-card premium-hover rounded-2xl border-black/5 shadow-sm">
            <CardContent className="flex items-start gap-3 p-5">
              <Users className="mt-0.5 h-5 w-5 text-black" />
              <div>
                <p className="text-sm font-semibold text-black">Suivi des cotisations</p>
                <p className="mt-1 text-xs text-gray-500">
                  Badges de paiement et indicateurs de fiabilite membre visibles instantanement.
                </p>
              </div>
            </CardContent>
          </Card>
          <Card className="premium-card premium-hover rounded-2xl border-black/5 shadow-sm">
            <CardContent className="flex items-start gap-3 p-5">
              <Sparkles className="mt-0.5 h-5 w-5 text-black" />
              <div>
                <p className="text-sm font-semibold text-black">Timeline intelligente</p>
                <p className="mt-1 text-xs text-gray-500">
                  Une progression claire des tours passes, en cours et a venir.
                </p>
              </div>
            </CardContent>
          </Card>
        </section>
      </ScreenContainer>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-md rounded-2xl border-black/10">
          <DialogHeader>
            <DialogTitle>Lance ta tontine en 30 secondes</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              <p className="font-medium text-gray-800">Parcours demo sans friction</p>
              <p className="mt-0.5">Nom, montant, membres, type et ordre. Le reste se fait automatiquement.</p>
            </div>
            {isDemoFlow ? (
              <div className="rounded-xl border border-black/10 bg-black px-3 py-2 text-xs text-white">
                Mode demo 60s actif: creation simplifiee, mode createur pre-active, puis collecte et redirection dashboard.
              </div>
            ) : null}
            <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <p className="font-semibold">Activer mode createur</p>
              <p className="mt-0.5">
                Tu gagneras X% sur chaque contribution selon le creatorFeeRate de ta communaute backend.
              </p>
            </div>

            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nom de la tontine"
              className="h-11 rounded-xl"
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="numeric"
                placeholder="Cotisation XOF"
                className="h-11 rounded-xl"
              />
              <Input
                value={maxMembers}
                onChange={(event) => setMaxMembers(event.target.value)}
                inputMode="numeric"
                placeholder="Nb membres"
                className="h-11 rounded-xl"
              />
            </div>

            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">Type visible</p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: "classic", label: "Classique" },
                  { id: "solidarity", label: "Libre" },
                  { id: "project", label: "Personnalisee" },
                ].map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant={tontineType === item.id ? "default" : "outline"}
                    className="press-feedback rounded-xl text-xs"
                    onClick={() => setTontineType(item.id as typeof tontineType)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Ordre de rotation</p>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-7 rounded-lg px-2 text-[11px] text-gray-500"
                  onClick={() => setShowFlexibleInfo(true)}
                >
                  <CircleHelp className="h-3.5 w-3.5" />
                  Voir logique backend
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: "fixed", label: "Fixe" },
                  { id: "random", label: "Flexible" },
                  { id: "auction", label: "Libre" },
                ].map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant={rotationMode === item.id ? "default" : "outline"}
                    className="press-feedback rounded-xl text-xs"
                    onClick={() => setRotationMode(item.id as RotationModel)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-gray-100 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-gray-800">Mode createur</p>
                <Button
                  type="button"
                  variant={creatorModeEnabled ? "default" : "outline"}
                  className="h-8 rounded-lg text-xs"
                  onClick={() => setCreatorModeEnabled((value) => !value)}
                >
                  {creatorModeEnabled ? "Active" : "Desactive"}
                </Button>
              </div>
              {!creatorModeEnabled ? (
                <p className="text-xs text-gray-500">
                  Active ce mode pour monétiser chaque collecte de ta tontine via ta communaute createur.
                </p>
              ) : creatorDashboardQuery.isLoading ? (
                <p className="text-xs text-gray-500">Chargement des communautes createur...</p>
              ) : creatorCommunities.length === 0 ? (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500">
                    Aucune communaute createur trouvee pour ton compte.
                  </p>
                  <Link href="/creator">
                    <Button type="button" variant="outline" className="press-feedback w-full rounded-xl text-xs">
                      Creer ma communaute
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="space-y-2">
                  <select
                    value={creatorCommunityId}
                    onChange={(event) => setCreatorCommunityId(event.target.value)}
                    className="h-10 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm"
                  >
                    {creatorCommunities.map((community) => (
                      <option key={community.id} value={community.id}>
                        {community.name} ({community.creatorFeeRate.toFixed(0)}%)
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-emerald-700">
                    {(() => {
                      const current = creatorCommunities.find((item) => item.id === creatorCommunityId);
                      const feeRate = current?.creatorFeeRate ?? creatorCommunities[0]?.creatorFeeRate ?? 0;
                      return `Tu gagneras ${feeRate.toFixed(0)}% sur chaque contribution.`;
                    })()}
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-gray-100 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-gray-800">Cotisations flexibles</p>
                <Button
                  type="button"
                  variant={isCustomContribution ? "default" : "outline"}
                  className="h-8 rounded-lg text-xs"
                  onClick={() => setIsCustomContribution((value) => !value)}
                >
                  {isCustomContribution ? "Personnalisee" : "Egale"}
                </Button>
              </div>
              {isCustomContribution ? (
                <div className="space-y-2">
                  {customRows.map((row, index) => (
                    <div key={`row-${index}`} className="grid grid-cols-2 gap-2">
                      <Input
                        value={row.userId}
                        onChange={(event) =>
                          setCustomRows((prev) =>
                            prev.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, userId: event.target.value } : item,
                            ),
                          )
                        }
                        placeholder="userId membre"
                        className="h-10 rounded-xl"
                      />
                      <Input
                        value={row.amount}
                        inputMode="numeric"
                        onChange={(event) =>
                          setCustomRows((prev) =>
                            prev.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, amount: event.target.value } : item,
                            ),
                          )
                        }
                        placeholder="Montant XOF"
                        className="h-10 rounded-xl"
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    className="press-feedback w-full rounded-xl"
                    onClick={() => setCustomRows((rows) => [...rows, { userId: "", amount: "" }])}
                  >
                    Ajouter un membre
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-gray-500">
                  Cotisation egale active: chaque membre cotise le meme montant de base.
                </p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2">
              {FREQUENCIES.map((freq) => (
                <Button
                  key={freq}
                  type="button"
                  variant={frequency === freq ? "default" : "outline"}
                  className="press-feedback rounded-xl"
                  onClick={() => setFrequency(freq)}
                >
                  {FREQ_LABEL[freq]}
                </Button>
              ))}
            </div>

            {createError ? (
              <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                {createError}
              </div>
            ) : null}

            <Button
              className="press-feedback w-full rounded-xl bg-black text-white hover:bg-black/90"
              onClick={handleCreate}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {createMutation.isPending ? "Creation..." : "Creer maintenant"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showFlexibleInfo} onOpenChange={setShowFlexibleInfo}>
        <DialogContent className="max-w-lg rounded-2xl border-black/10">
          <DialogHeader>
            <DialogTitle>Tontine libre (ordre flexible)</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-gray-600">
            <p>
              Backend existant: l'ordre flexible est gere par <strong>rotationModel=random</strong> ou{" "}
              <strong>rotationModel=auction</strong> via <code>/community/tontines/:id/activate</code>.
            </p>
            <p>
              Cette configuration est appliquee automatiquement dans ce frontend lors de la creation.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <ExplorerDialog
        open={showExplorer}
        onOpenChange={setShowExplorer}
        token={token}
        onOpenTontine={(id) => navigate(`/tontine/${id}`)}
      />

      <BottomNav />
    </div>
  );
}

function ExplorerDialog({
  open,
  onOpenChange,
  token,
  onOpenTontine,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string | null;
  onOpenTontine: (id: string) => void;
}) {
  const [zoneQuery, setZoneQuery] = useState("");
  const [type, setType] = useState<string>("all");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [minMembers, setMinMembers] = useState("");

  const explorerQuery = useQuery({
    queryKey: ["akwe-explorer", zoneQuery, type, minAmount, maxAmount, minMembers],
    enabled: open,
    queryFn: () =>
      searchPublicTontines(token, {
        zoneQuery,
        type: type === "all" ? undefined : type === "solidarity" ? "classic" : type,
        minAmount: minAmount ? Number(minAmount) : undefined,
        maxAmount: maxAmount ? Number(maxAmount) : undefined,
        minMembers: minMembers ? Number(minMembers) : undefined,
      }),
  });

  const rows = explorerQuery.data?.tontines ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl rounded-2xl border-black/10">
        <DialogHeader>
          <DialogTitle>Explorer les tontines</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={zoneQuery}
            onChange={(event) => setZoneQuery(event.target.value)}
            placeholder="Trouve une tontine proche de toi (ville / pays)"
            className="h-11 rounded-xl"
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Input
              value={minAmount}
              inputMode="numeric"
              onChange={(event) => setMinAmount(event.target.value)}
              placeholder="Montant min"
              className="h-10 rounded-xl"
            />
            <Input
              value={maxAmount}
              inputMode="numeric"
              onChange={(event) => setMaxAmount(event.target.value)}
              placeholder="Montant max"
              className="h-10 rounded-xl"
            />
            <Input
              value={minMembers}
              inputMode="numeric"
              onChange={(event) => setMinMembers(event.target.value)}
              placeholder="Membres min"
              className="h-10 rounded-xl"
            />
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
              className="h-10 rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm"
            >
              <option value="all">Type</option>
              <option value="classic">Classique</option>
              <option value="solidarity">Libre</option>
              <option value="project">Personnalisee</option>
              <option value="investment">Investissement</option>
            </select>
          </div>

          {explorerQuery.isLoading ? (
            <SkeletonCard rows={4} className="bg-transparent px-0 py-0 shadow-none border-none" />
          ) : rows.length === 0 ? (
            <EmptyHint
              title="Aucune tontine trouvee"
              description="Essaie avec une zone differente ou des filtres plus larges."
            />
          ) : (
            <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
              {rows.map((item, index) => (
                <button
                  key={item.id}
                  className="premium-hover w-full rounded-xl border border-gray-100 bg-white px-3 py-3 text-left transition hover:border-black/15"
                  onClick={() => onOpenTontine(item.id)}
                  style={{
                    animation: "premium-page-enter 320ms cubic-bezier(0.16, 1, 0.3, 1)",
                    animationDelay: `${Math.min(index * 40, 220)}ms`,
                    animationFillMode: "both",
                  }}
                >
                  <p className="text-sm font-semibold text-black">{item.name}</p>
                  <p className="mt-1 text-xs text-gray-500">
                    {formatXOF(item.contributionAmount)} - {item.memberCount}/{item.maxMembers} membres
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
