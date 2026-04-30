import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { BellRing, Copy, Loader2, MessageCircleMore, Sparkles, Users } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { formatXOF } from "@/lib/api";
import { collectContribution, getTontineOverview } from "@/services/api/tontineService";
import {
  distributeCommunityEarnings,
  loadCreatorModeLink,
  recordCreatorDailyEarning,
} from "@/services/api/creatorService";
import { nextReceiverLabel, timelineBulletColor, tontineHealthColor } from "@/features/tontine/tontine-ui";
import { useToast } from "@/hooks/use-toast";
import { EmptyHint, ScreenContainer, SectionIntro, SkeletonCard } from "@/components/premium/PremiumStates";
import { invalidateCacheByMutation } from "@/lib/cachePolicy";
import { trackUxAction } from "@/lib/frontendMonitor";

interface Props {
  params: { id: string };
}

function paymentBadge(status: "paid" | "late"): string {
  return status === "paid"
    ? "bg-emerald-50 text-emerald-700 border-emerald-100"
    : "bg-amber-50 text-amber-700 border-amber-100";
}

export default function TontineDetailModern({ params }: Props) {
  const { token, user } = useAuth();
  const { toast } = useToast();
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();

  const tontineQuery = useQuery({
    queryKey: ["akwe-tontine-detail", params.id],
    queryFn: () => getTontineOverview(token, params.id),
    enabled: Boolean(params.id),
  });

  const tontine = tontineQuery.data?.tontine;
  const usingMock = tontineQuery.data?.usingMock ?? false;
  const creatorLink = loadCreatorModeLink(params.id);
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
  const inviteLink = useMemo(() => {
    const query = new URLSearchParams({
      tontine: params.id,
      community: creatorLink?.communityId ?? "",
    });
    if (typeof window === "undefined") {
      return `/tontine/${params.id}?${query.toString()}`;
    }
    return `${window.location.origin}/tontine/${params.id}?${query.toString()}`;
  }, [creatorLink?.communityId, params.id]);

  const collectMutation = useMutation({
    mutationFn: async () => {
      const collectResult = await collectContribution(token, params.id);
      let creatorEarningsApplied = false;
      let creatorEarningsError: string | null = null;
      let creatorFeeApplied = 0;
      if (creatorLink && collectResult.totalCollected > 0) {
        try {
          const earnings = await distributeCommunityEarnings(
            token,
            creatorLink.communityId,
            collectResult.totalCollected,
            creatorLink.creatorFeeRate,
          );
          creatorEarningsApplied = true;
          creatorFeeApplied = earnings.creatorFee;
        } catch (error) {
          creatorEarningsError =
            error instanceof Error ? error.message : "Distribution createur indisponible.";
        }
      }
      return {
        ...collectResult,
        creatorEarningsApplied,
        creatorEarningsError,
        creatorFeeApplied,
      };
    },
    onSuccess: async (result) => {
      invalidateCacheByMutation("collect", user?.id ?? null);
      trackUxAction("tontine.collect.success", {
        tontineId: params.id,
        totalCollected: result.totalCollected,
      });
      await queryClient.invalidateQueries({ queryKey: ["akwe-tontine-detail", params.id] });
      await queryClient.invalidateQueries({ queryKey: ["akwe-tontines", user?.id] });
      if (result.creatorEarningsApplied && result.creatorFeeApplied > 0) {
        recordCreatorDailyEarning(result.creatorFeeApplied);
      }
      toast({
        title: "Collecte terminee",
        description: creatorLink
          ? result.creatorEarningsApplied
            ? `Collecte backend: ${formatXOF(result.totalCollected)}. Commission createur distribuee automatiquement.`
            : `Collecte backend: ${formatXOF(result.totalCollected)}. Distribution createur non appliquee (${result.creatorEarningsError ?? "indisponible"}).`
          : "La progression de la tontine est mise a jour.",
      });
      if (creatorLink && isDemoFlow) {
        navigate("/creator-dashboard?from=tontine");
      }
    },
    onError: (error: unknown) => {
      trackUxAction("tontine.collect.failed", {
        tontineId: params.id,
        message: error instanceof Error ? error.message : "unknown",
      });
      toast({
        variant: "destructive",
        title: "Collecte impossible",
        description: error instanceof Error ? error.message : "Reessaie dans quelques secondes.",
      });
    },
  });

  const memberMetrics = useMemo(() => {
    if (!tontine) return { paid: 0, late: 0 };
    const paid = tontine.members.filter((member) => member.paymentStatus === "paid").length;
    return { paid, late: tontine.members.length - paid };
  }, [tontine]);

  return (
    <div className="min-h-screen bg-[#fcfcfb] pb-24">
      <TopBar title="Detail tontine" showBack onBack={() => navigate("/tontine")} />
      <ScreenContainer>
        <SectionIntro
          title="Vue complete de ta tontine"
          subtitle="Membres, tours, fiabilite et timeline dans une seule lecture."
        />
        {tontineQuery.isLoading ? (
          <SkeletonCard rows={6} />
        ) : null}

        {usingMock ? (
          <div className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
            Mode simulation active: quelques donnees detaillees utilisent un fallback premium.
          </div>
        ) : null}

        {!tontineQuery.isLoading && tontine ? (
          <>
            <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
              <CardHeader className="gap-2">
                <CardTitle className="text-xl font-bold">{tontine.name}</CardTitle>
                <p className="text-xs text-gray-500">
                  {formatXOF(tontine.contributionAmount)} par tour - {tontine.memberCount}/{tontine.maxMembers} membres
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MetricCard label="Cycle" value={`${tontine.currentRound}/${tontine.totalRounds}`} />
                  <MetricCard label="Cotisation" value={formatXOF(tontine.contributionAmount)} />
                  <MetricCard label="Paye" value={`${memberMetrics.paid}`} />
                  <MetricCard label="Retard" value={`${memberMetrics.late}`} />
                </div>
                <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
                  <p className="text-xs font-medium text-gray-500">Prochaine distribution</p>
                  <p className="mt-1 text-sm font-semibold text-black">
                    {nextReceiverLabel(tontine.nextReceiver?.userName)}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <MetricCard
                    label="Type backend"
                    value={tontine.tontineType}
                  />
                  <MetricCard
                    label="Mode cotisation"
                    value={tontine.members.some((member) => member.personalContribution != null) ? "Personnalisee" : "Egale"}
                  />
                  <MetricCard
                    label="Ordre tours"
                    value="Selon payoutOrder"
                  />
                </div>
                {tontine.description ? (
                  <div className="rounded-2xl border border-gray-100 bg-white px-4 py-3">
                    <p className="text-xs font-medium text-gray-500">Description</p>
                    <p className="mt-1 text-sm text-gray-700">{tontine.description}</p>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="press-feedback rounded-xl bg-black text-white hover:bg-black/90"
                    onClick={() => collectMutation.mutate()}
                    disabled={collectMutation.isPending}
                  >
                    {collectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {collectMutation.isPending ? "Collecte..." : "Simuler collecte"}
                  </Button>
                  <Link href="/wallet">
                    <Button variant="outline" className="press-feedback rounded-xl">
                      Aller au wallet
                    </Button>
                  </Link>
                  {creatorLink ? (
                    <Button
                      variant="outline"
                      className="press-feedback rounded-xl"
                      onClick={async () => {
                        await navigator.clipboard.writeText(inviteLink).catch(() => undefined);
                        toast({
                          title: "Lien de partage copie",
                          description: "Partage ta tontine pour booster les contributions.",
                        });
                      }}
                    >
                      <Copy className="h-4 w-4" />
                      Partager ma tontine
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base font-semibold">Membres et fiabilite</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {tontine.members.map((member, index) => (
                  <div
                    key={member.userId}
                    className="premium-hover flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-100 px-4 py-3"
                    style={{
                      animation: "premium-page-enter 320ms cubic-bezier(0.16, 1, 0.3, 1)",
                      animationDelay: `${Math.min(index * 40, 240)}ms`,
                      animationFillMode: "both",
                    }}
                  >
                    <div>
                      <p className="text-sm font-semibold text-black">{member.userName}</p>
                      <p className="text-xs text-gray-500">Ordre #{member.payoutOrder}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tontineHealthColor(member.reliabilityLabel)}`}>
                        Score {member.reliabilityScore}
                      </span>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${paymentBadge(member.paymentStatus)}`}>
                        {member.paymentStatus === "paid" ? "Paye" : "En retard"}
                      </span>
                      {member.personalContribution != null ? (
                        <span className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700">
                          {formatXOF(member.personalContribution)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base font-semibold">Timeline de la tontine</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {tontine.timeline.length === 0 ? (
                  <EmptyHint
                    title="Timeline en preparation"
                    description="Les prochains evenements apparaitront ici automatiquement."
                  />
                ) : (
                  tontine.timeline.map((item, index) => (
                    <div
                      key={item.id}
                      className="flex items-start gap-3"
                      style={{
                        animation: "premium-page-enter 320ms cubic-bezier(0.16, 1, 0.3, 1)",
                        animationDelay: `${Math.min(index * 50, 260)}ms`,
                        animationFillMode: "both",
                      }}
                    >
                      <span className={`mt-1 h-2.5 w-2.5 rounded-full ${timelineBulletColor(item.status)}`} />
                      <div className="rounded-xl border border-gray-100 px-3 py-3">
                        <p className="text-sm font-semibold text-black">{item.title}</p>
                        <p className="text-xs text-gray-500">{item.subtitle}</p>
                        <p className="mt-1 text-[11px] font-medium text-gray-400">{item.dateLabel}</p>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <section className="grid gap-3 sm:grid-cols-2">
              <Card className="premium-card premium-hover rounded-2xl border-black/5 shadow-sm">
                <CardContent className="flex items-start gap-3 p-5">
                  <MessageCircleMore className="mt-0.5 h-5 w-5 text-black" />
                  <div>
                    <p className="text-sm font-semibold text-black">Chat de groupe (placeholder)</p>
                    <p className="mt-1 text-xs text-gray-500">
                      Zone reservee pour les echanges membres dans une version suivante.
                    </p>
                  </div>
                </CardContent>
              </Card>
              <Card className="premium-card premium-hover rounded-2xl border-black/5 shadow-sm">
                <CardContent className="flex items-start gap-3 p-5">
                  <BellRing className="mt-0.5 h-5 w-5 text-black" />
                  <div>
                    <p className="text-sm font-semibold text-black">Notifications</p>
                    <p className="mt-1 text-xs text-gray-500">
                      Rappels de cotisation, statut des paiements et alertes tour.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </section>

            <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base font-semibold">Historique & notifications</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {tontine.notifications.map((note, index) => (
                  <div key={`${note}-${index}`} className="rounded-xl border border-gray-100 px-3 py-2 text-sm text-gray-600">
                    {note}
                  </div>
                ))}
                {tontine.history.map((event) => (
                  <div key={event.id} className="rounded-xl border border-gray-100 px-3 py-2">
                    <p className="text-sm font-medium text-black">{event.title}</p>
                    <p className="text-xs text-gray-500">{event.subtitle}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </>
        ) : null}

        {!tontineQuery.isLoading && !tontine ? (
          <EmptyHint
            title="Tontine introuvable"
            description="Retourne a la liste pour ouvrir une tontine active."
            action={
              <Link href="/tontine">
                <Button className="press-feedback rounded-xl bg-black text-white hover:bg-black/90">Retour a la liste</Button>
              </Link>
            }
          />
        ) : null}

        <div className="rounded-2xl border border-gray-100 bg-white px-4 py-3 text-xs text-gray-500">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Frontend adapte au backend existant, sans modification de logique metier.
          </div>
        </div>
      </ScreenContainer>
      <BottomNav />
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white px-3 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 text-sm font-semibold text-black">{value}</p>
    </div>
  );
}
