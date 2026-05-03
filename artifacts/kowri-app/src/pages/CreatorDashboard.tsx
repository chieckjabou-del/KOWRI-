import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Loader2 } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { ScreenContainer, SectionIntro } from "@/components/premium/PremiumStates";
import { useToast } from "@/hooks/use-toast";
import { persistShareDailyCount, useCreatorDashboardData } from "@/pages/creator-dashboard/useCreatorDashboardData";
import { readCache, writeCache } from "@/lib/localCache";
import { useNamedSmartWarmup } from "@/hooks/useSmartWarmup";
import { DATA_TTL_MS } from "@/lib/cachePolicy";
import {
  DailyLoopCard,
  IntroViralCard,
  InviteCard,
  LevelCard,
  MetricsGrid,
  MoneyFocusCard,
  ReputationCard,
  RankingCard,
  TontineRevenueCard,
} from "@/pages/creator-dashboard/sections";

export default function CreatorDashboard() {
  const { toast } = useToast();
  useNamedSmartWarmup("creator");
  const [shareBurst, setShareBurst] = useState(false);
  const [cachedSnapshot] = useState(() =>
    readCache<{ totalEarnings: number; totalMembers: number; totalVolume: number }>(
      "creator-dashboard-snapshot",
    ) ?? { totalEarnings: 0, totalMembers: 0, totalVolume: 0 },
  );
  const {
    selectedTontineId,
    setSelectedTontineId,
    dashboardQuery,
    poolsQuery,
    rankingQuery,
    reputationQuery,
    inviteTarget,
    inviteLink,
    topRows,
    rankingRows,
    totalTontines,
    totalMembersInTontines,
    averageFeeRate,
    hundredMembersVisual,
    currentLevel,
    progressPercent,
    pointsToNext,
    primaryBadge,
    dynamicMessage,
    dailyGain,
    totalGenerated,
    mainMoneyValue,
    nextInviteGoal,
    shareCount,
    setShareCount,
    setShareDailyCountMap,
    retentionState,
    dailyGoals,
    goalsCompleted,
    today,
    invitedCount,
    nextLevelLabel,
  } = useCreatorDashboardData();

  useEffect(() => {
    const stats = dashboardQuery.data?.dashboard.stats;
    if (!stats) return;
    writeCache(
      "creator-dashboard-snapshot",
      {
        totalEarnings: stats.totalEarnings,
        totalMembers: stats.totalMembers,
        totalVolume: stats.totalVolume,
      },
      { ttlMs: DATA_TTL_MS.CREATOR_DASHBOARD },
    );
  }, [dashboardQuery.data?.dashboard.stats]);

  return (
    <div className="min-h-screen bg-[#fcfcfb] pb-24">
      <TopBar title="Creator Dashboard" />
      <ScreenContainer>
        <SectionIntro
          title="Tu gagnes de l'argent avec ta communaute"
          subtitle="Données réelles connectées au backend créateur existant, sans logique inventée."
          actions={
            <Link href="/creator">
              <Button variant="outline" className="press-feedback rounded-xl">
                Creer ma communaute
              </Button>
            </Link>
          }
        />

        <IntroViralCard averageFeeRate={averageFeeRate} hundredMembersVisual={hundredMembersVisual} />

        <DailyLoopCard streak={retentionState.streak} goalsCompleted={goalsCompleted} dailyGoals={dailyGoals} />

        <LevelCard
          currentLevel={currentLevel}
          shareBurst={shareBurst}
          reputationScore={reputationQuery.data?.score ?? 0}
          progressPercent={progressPercent}
          nextLevelLabel={nextLevelLabel}
          pointsToNext={pointsToNext}
          primaryBadge={primaryBadge}
          dynamicMessage={dynamicMessage}
        />

        <MetricsGrid
          totalEarnings={dashboardQuery.data?.dashboard.stats.totalEarnings ?? cachedSnapshot.totalEarnings}
          totalMembersInTontines={totalMembersInTontines}
          totalTontines={totalTontines}
          totalVolume={dashboardQuery.data?.dashboard.stats.totalVolume ?? cachedSnapshot.totalVolume}
        />

        <MoneyFocusCard
          shareBurst={shareBurst}
          dailyGain={dailyGain}
          mainMoneyValue={mainMoneyValue}
          totalGenerated={totalGenerated}
          hundredMembersVisual={hundredMembersVisual}
        />

        <ReputationCard
          isLoading={reputationQuery.isLoading}
          score={reputationQuery.data?.score ?? 0}
          tier={reputationQuery.data?.tier ?? "new"}
          badgeCount={reputationQuery.data?.badgeCount ?? 0}
          badges={(reputationQuery.data?.badges ?? []).map((badge) => ({
            badge: badge.badge,
            label: badge.label,
          }))}
        />

        <TontineRevenueCard isLoading={dashboardQuery.isLoading || poolsQuery.isLoading} rows={topRows} />

        <RankingCard isLoading={rankingQuery.isLoading} rankingRows={rankingRows} />

        <InviteCard
          isEmpty={topRows.length === 0}
          creatorFeeRate={inviteTarget?.creatorFeeRate ?? 0}
          invitedCount={invitedCount}
          nextInviteGoal={nextInviteGoal}
          selectedId={selectedTontineId}
          options={topRows}
          inviteLink={inviteLink}
          estimatedRevenue={inviteTarget?.estimatedCreatorRevenue ?? 0}
          onSelect={(value) => setSelectedTontineId(value)}
          onShare={async () => {
            if (!inviteLink) return;
            await navigator.clipboard.writeText(inviteLink).catch(() => undefined);
            setShareBurst(true);
            setShareCount((value) => {
              const nextValue = value + 1;
              if (typeof window !== "undefined") {
                try {
                  window.localStorage.setItem("akwe-share-count", String(nextValue));
                } catch {
                  // ignore storage failures
                }
              }
              return nextValue;
            });
            persistShareDailyCount(setShareDailyCountMap, today);
            if (typeof window !== "undefined") {
              window.setTimeout(() => setShareBurst(false), 900);
            } else {
              setShareBurst(false);
            }
            toast({
              title: "Lien copie",
              description: "Partage ta tontine pour accelerer la croissance.",
            });
          }}
          shareBurst={shareBurst}
          shareCount={shareCount}
        />

        {(dashboardQuery.error || poolsQuery.error) ? (
          <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-xs font-medium text-red-700">
            Impossible de charger certaines donnees createur depuis le backend.
          </div>
        ) : null}

        {(dashboardQuery.isLoading || poolsQuery.isLoading) ? (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Synchronisation des donnees createur...
          </div>
        ) : null}
      </ScreenContainer>
      <BottomNav />
    </div>
  );
}
