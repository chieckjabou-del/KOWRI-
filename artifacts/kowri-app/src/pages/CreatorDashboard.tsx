import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CheckCircle2, Coins, Copy, Flame, Loader2, Share2, Sparkles, TrendingUp, Trophy, Users } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { formatXOF } from "@/lib/api";
import {
  getCommunityPools,
  getCreatorDashboard,
  getCreatorReputationProfile,
  getCreatorReputationSnapshot,
  getTontineContributionSnapshot,
  listCreatorCommunities,
  readCreatorDailyEarning,
} from "@/services/api/creatorService";
import { EmptyHint, ScreenContainer, SectionIntro, SkeletonCard } from "@/components/premium/PremiumStates";
import { useToast } from "@/hooks/use-toast";

interface CreatorTontineRevenueRow {
  id: string;
  name: string;
  communityId: string;
  communityName: string;
  memberCount: number;
  contributionAmount: number;
  totalContributed: number;
  estimatedCreatorRevenue: number;
  creatorFeeRate: number;
  status: string;
}

interface CreatorRankingRow {
  id: string;
  label: string;
  earnings: number;
  members: number;
  score: number;
  points: number;
  isYou?: boolean;
}

interface LevelConfig {
  key: "bronze" | "silver" | "gold";
  label: string;
  minScore: number;
  maxScore: number;
  accentClass: string;
  cardClass: string;
}

const LEVELS: LevelConfig[] = [
  {
    key: "bronze",
    label: "Bronze",
    minScore: 0,
    maxScore: 449,
    accentClass: "text-amber-700",
    cardClass: "border-amber-100 bg-amber-50",
  },
  {
    key: "silver",
    label: "Silver",
    minScore: 450,
    maxScore: 749,
    accentClass: "text-slate-700",
    cardClass: "border-slate-200 bg-slate-50",
  },
  {
    key: "gold",
    label: "Gold",
    minScore: 750,
    maxScore: 100000,
    accentClass: "text-yellow-700",
    cardClass: "border-yellow-100 bg-yellow-50",
  },
];

const BADGE_PRIORITY = [
  "community_champion",
  "legend",
  "diamond",
  "platinum",
  "gold",
  "silver",
  "bronze",
];

const RETENTION_STATE_KEY = "akwe-retention-loop-state";
const SHARE_DAILY_COUNT_KEY = "akwe-share-daily-counts";

interface RetentionState {
  lastActiveDate: string;
  streak: number;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayIsoDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date.toISOString().slice(0, 10);
}

function readRetentionState(): RetentionState {
  if (typeof window === "undefined") {
    return { lastActiveDate: "", streak: 0 };
  }
  try {
    const raw = window.localStorage.getItem(RETENTION_STATE_KEY);
    if (!raw) return { lastActiveDate: "", streak: 0 };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      lastActiveDate: typeof parsed.lastActiveDate === "string" ? parsed.lastActiveDate : "",
      streak: Number.isFinite(Number(parsed.streak)) ? Number(parsed.streak) : 0,
    };
  } catch {
    return { lastActiveDate: "", streak: 0 };
  }
}

function readShareDailyCounts(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SHARE_DAILY_COUNT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, Number.isFinite(Number(value)) ? Number(value) : 0]),
    );
  } catch {
    return {};
  }
}

function levelFromScore(score: number): LevelConfig {
  return LEVELS.find((item) => score >= item.minScore && score <= item.maxScore) ?? LEVELS[0];
}

function nextLevel(currentLevel: LevelConfig): LevelConfig | null {
  const currentIndex = LEVELS.findIndex((item) => item.key === currentLevel.key);
  if (currentIndex < 0 || currentIndex === LEVELS.length - 1) return null;
  return LEVELS[currentIndex + 1];
}

function canonicalTier(rawTier: string | undefined): string {
  const value = (rawTier ?? "").toLowerCase();
  if (value.includes("gold")) return "gold";
  if (value.includes("silver")) return "silver";
  if (value.includes("bronze")) return "bronze";
  return "bronze";
}

function pickPrimaryBadge(
  badges: Array<{ badge: string; label: string; description: string }>,
): { badge: string; label: string; description: string } | null {
  if (!badges.length) return null;
  return [...badges].sort((a, b) => {
    const rankA = BADGE_PRIORITY.findIndex((key) => a.badge.toLowerCase().includes(key));
    const rankB = BADGE_PRIORITY.findIndex((key) => b.badge.toLowerCase().includes(key));
    const scoreA = rankA === -1 ? BADGE_PRIORITY.length + 1 : rankA;
    const scoreB = rankB === -1 ? BADGE_PRIORITY.length + 1 : rankB;
    return scoreA - scoreB;
  })[0];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function CreatorDashboard() {
  const { token, user } = useAuth();
  const { toast } = useToast();
  const [selectedTontineId, setSelectedTontineId] = useState("");
  const [shareBurst, setShareBurst] = useState(false);
  const [shareCount, setShareCount] = useState(() => {
    if (typeof window === "undefined") return 0;
    try {
      return Number(window.localStorage.getItem("akwe-share-count") ?? 0);
    } catch {
      return 0;
    }
  });
  const [retentionState, setRetentionState] = useState<RetentionState>(() => readRetentionState());
  const [shareDailyCountMap, setShareDailyCountMap] = useState<Record<string, number>>(() =>
    readShareDailyCounts(),
  );

  const dashboardQuery = useQuery({
    queryKey: ["creator-dashboard-machine", user?.id],
    enabled: Boolean(user?.id),
    queryFn: () => getCreatorDashboard(token, user!.id),
  });

  const communities = dashboardQuery.data?.dashboard.communities ?? [];

  const poolsQuery = useQuery({
    queryKey: ["creator-dashboard-machine-pools", communities.map((item) => item.id).join(",")],
    enabled: communities.length > 0,
    queryFn: async (): Promise<CreatorTontineRevenueRow[]> => {
      const rows: CreatorTontineRevenueRow[] = [];
      for (const community of communities) {
        const pools = await getCommunityPools(token, community.id);
        for (const rawTontine of pools.tontines) {
          const tontineId = typeof rawTontine.id === "string" ? rawTontine.id : "";
          if (!tontineId) continue;
          const snap = await getTontineContributionSnapshot(token, tontineId).catch(() => null);
          const memberCount = Number(
            rawTontine.memberCount ?? snap?.memberCount ?? 0,
          );
          const contributionAmount = Number(
            rawTontine.contributionAmount ?? snap?.contributionAmount ?? 0,
          );
          const totalContributed = Number(snap?.totalContributed ?? 0);
          const creatorFeeRate = Number(community.creatorFeeRate ?? 5);
          rows.push({
            id: tontineId,
            name: typeof rawTontine.name === "string" ? rawTontine.name : `Tontine ${tontineId.slice(0, 6)}`,
            communityId: community.id,
            communityName: community.name,
            memberCount,
            contributionAmount,
            totalContributed,
            // Backend formula: creatorFee = transactionAmount * creatorFeeRate / 100
            estimatedCreatorRevenue: totalContributed * (creatorFeeRate / 100),
            creatorFeeRate,
            status: typeof rawTontine.status === "string" ? rawTontine.status : "pending",
          });
        }
      }
      return rows;
    },
  });

  const reputationQuery = useQuery({
    queryKey: ["creator-reputation-profile", user?.id],
    enabled: Boolean(user?.id),
    queryFn: () => getCreatorReputationProfile(token, user!.id),
    retry: false,
  });

  const rankingQuery = useQuery({
    queryKey: ["creator-top-ranking-local", user?.id, dashboardQuery.data?.dashboard.stats.totalEarnings ?? 0, dashboardQuery.data?.dashboard.stats.totalMembers ?? 0],
    enabled: Boolean(user?.id),
    queryFn: async (): Promise<CreatorRankingRow[]> => {
      const communitiesResult = await listCreatorCommunities(token).catch(() => ({
        communities: [],
        usingMock: false,
      }));
      const communities = communitiesResult.communities;
      const uniqueCreatorIds = Array.from(
        new Set(
          communities
            .map((community) => community.creatorId)
            .filter((value): value is string => typeof value === "string" && value.length > 0),
        ),
      ).slice(0, 12);

      const scoreMap = new Map<string, number>();
      await Promise.all(
        uniqueCreatorIds.map(async (creatorId) => {
          const snapshot = await getCreatorReputationSnapshot(token, creatorId);
          scoreMap.set(creatorId, snapshot?.score ?? 0);
        }),
      );

      const rowsByCreator = new Map<string, CreatorRankingRow>();
      for (const community of communities) {
        const creatorId = community.creatorId || "unknown";
        const current = rowsByCreator.get(creatorId) ?? {
          id: creatorId,
          label:
            creatorId === user?.id
              ? "Toi"
              : community.handle
                ? `@${community.handle}`
                : `Createur ${creatorId.slice(0, 6)}`,
          earnings: 0,
          members: 0,
          score: scoreMap.get(creatorId) ?? 0,
          points: 0,
          isYou: creatorId === user?.id,
        };
        current.earnings += community.totalVolume * (community.creatorFeeRate / 100);
        current.members += community.memberCount;
        current.score = scoreMap.get(creatorId) ?? current.score;
        rowsByCreator.set(creatorId, current);
      }

      if (user?.id && !rowsByCreator.has(user.id)) {
        rowsByCreator.set(user.id, {
          id: user.id,
          label: "Toi",
          earnings: 0,
          members: 0,
          score: 0,
          points: 0,
          isYou: true,
        });
      }

      const rows = Array.from(rowsByCreator.values());
      if (!rows.length) return [];
      const maxEarnings = Math.max(...rows.map((item) => item.earnings), 1);
      const maxMembers = Math.max(...rows.map((item) => item.members), 1);
      const maxScore = Math.max(...rows.map((item) => item.score), 1);
      for (const row of rows) {
        const earningsIndex = row.earnings / maxEarnings;
        const membersIndex = row.members / maxMembers;
        const scoreIndex = row.score / maxScore;
        row.points = Math.round(earningsIndex * 45 + membersIndex * 30 + scoreIndex * 25);
      }
      return rows.sort((a, b) => b.points - a.points).slice(0, 6);
    },
  });

  const rows = poolsQuery.data ?? [];
  const totalTontines = rows.length;
  const totalMembersInTontines = rows.reduce((sum, row) => sum + row.memberCount, 0);
  const averageFeeRate = communities.length
    ? communities.reduce((sum, row) => sum + row.creatorFeeRate, 0) / communities.length
    : 0;

  const primaryRow = rows[0];
  const oneMemberGain = primaryRow
    ? primaryRow.contributionAmount * (primaryRow.creatorFeeRate / 100)
    : 0;
  const hundredMembersVisual = oneMemberGain * 100;

  const topRows = useMemo(
    () => [...rows].sort((a, b) => b.estimatedCreatorRevenue - a.estimatedCreatorRevenue),
    [rows],
  );
  const inviteTarget = topRows.find((item) => item.id === selectedTontineId) ?? topRows[0];

  const inviteLink = useMemo(() => {
    if (!inviteTarget) return "";
    const params = new URLSearchParams({
      tontine: inviteTarget.id,
      community: inviteTarget.communityId,
    });
    if (typeof window === "undefined") {
      return `/tontine/${inviteTarget.id}?${params.toString()}`;
    }
    return `${window.location.origin}/tontine/${inviteTarget.id}?${params.toString()}`;
  }, [inviteTarget]);

  const rankingRows = rankingQuery.data ?? [];
  const reputationScore = reputationQuery.data?.score ?? 0;
  const tierLevel = LEVELS.find((item) => item.key === canonicalTier(reputationQuery.data?.tier)) ?? LEVELS[0];
  const scoreLevel = levelFromScore(reputationScore);
  const currentLevel =
    LEVELS.findIndex((item) => item.key === tierLevel.key) > LEVELS.findIndex((item) => item.key === scoreLevel.key)
      ? tierLevel
      : scoreLevel;
  const next = nextLevel(currentLevel);
  const progressPercent = next
    ? clamp(
        ((reputationScore - currentLevel.minScore) / Math.max(next.minScore - currentLevel.minScore, 1)) * 100,
        0,
        100,
      )
    : 100;
  const pointsToNext = next ? Math.max(next.minScore - reputationScore, 0) : 0;
  const primaryBadge = pickPrimaryBadge(reputationQuery.data?.badges ?? []);

  const dailyGain = useMemo(() => readCreatorDailyEarning(), []);
  const totalGenerated = dashboardQuery.data?.dashboard.stats.totalEarnings ?? 0;
  const mainMoneyValue = dailyGain > 0 ? dailyGain : totalGenerated;
  const invitedCount = inviteTarget?.memberCount ?? 0;
  const inviteTargetGain = (inviteTarget?.contributionAmount ?? 0) * ((inviteTarget?.creatorFeeRate ?? 0) / 100);
  const nextInviteGoal = inviteTargetGain * 10;
  const dynamicMessage =
    currentLevel.key === "gold"
      ? "Les createurs niveau Gold gagnent plus et attirent plus de membres."
      : currentLevel.key === "silver"
        ? "Encore une poussee et tu passes Gold pour augmenter ta traction."
        : "Passe Silver rapidement pour accelerer ta credibilite createur.";
  const today = todayIsoDate();
  const yesterday = yesterdayIsoDate();
  const shareToday = shareDailyCountMap[today] ?? 0;
  const targetShares = 3;
  const targetMembers = 5;
  const targetTodayGain = 10000;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = readRetentionState();
    let nextStreak = current.streak;
    if (current.lastActiveDate === today) return;
    if (current.lastActiveDate === yesterday) {
      nextStreak = Math.max(1, current.streak + 1);
    } else {
      nextStreak = 1;
    }
    const nextState: RetentionState = { lastActiveDate: today, streak: nextStreak };
    setRetentionState(nextState);
    try {
      window.localStorage.setItem(RETENTION_STATE_KEY, JSON.stringify(nextState));
    } catch {
      // ignore storage failures
    }
  }, [today, yesterday]);

  const dailyGoals = [
    {
      id: "share",
      label: "Partager 3 fois ta tontine",
      progress: shareToday,
      target: targetShares,
      done: shareToday >= targetShares,
    },
    {
      id: "members",
      label: "Atteindre 5 membres invites",
      progress: invitedCount,
      target: targetMembers,
      done: invitedCount >= targetMembers,
    },
    {
      id: "earnings",
      label: "Generer 10 000 XOF aujourd'hui",
      progress: mainMoneyValue,
      target: targetTodayGain,
      done: mainMoneyValue >= targetTodayGain,
    },
  ];
  const goalsCompleted = dailyGoals.filter((goal) => goal.done).length;

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

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardContent className="space-y-3 pt-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">UX virale</p>
            <p className="text-sm font-semibold text-black">
              Chaque membre qui rejoint ta tontine te rapporte environ {averageFeeRate.toFixed(0)}%
              {" "}sur les contributions enregistrees.
            </p>
            <p className="text-xs text-gray-500">
              Simulation visuelle: si tu ajoutes 100 personnes sur un tour de reference,
              tu peux generer {formatXOF(hundredMembersVisual)} de commission createur.
            </p>
          </CardContent>
        </Card>

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold">Boucle de retour journaliere</CardTitle>
            <div className="flex items-center gap-1.5 rounded-full border border-orange-100 bg-orange-50 px-2.5 py-1 text-xs font-semibold text-orange-700">
              <Flame className="h-3.5 w-3.5" />
              Streak {retentionState.streak}j
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-2xl border border-gray-100 bg-gray-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Objectifs du jour</p>
              <p className="mt-1 text-sm font-semibold text-black">
                {goalsCompleted}/3 completes. Reviens demain pour prolonger ta serie.
              </p>
            </div>
            <div className="space-y-2">
              {dailyGoals.map((goal) => (
                <div key={goal.id} className="rounded-xl border border-gray-100 bg-white px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-black">{goal.label}</p>
                    {goal.done ? (
                      <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        OK
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-gray-100">
                    <div
                      className={`h-1.5 rounded-full ${goal.done ? "bg-emerald-600" : "bg-black"}`}
                      style={{ width: `${clamp((goal.progress / Math.max(goal.target, 1)) * 100, 0, 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-gray-500">
                    {goal.progress >= goal.target
                      ? `Objectif atteint (${goal.progress}/${goal.target}).`
                      : `Encore ${Math.max(goal.target - goal.progress, 0)} pour valider.`}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className={`premium-card rounded-3xl border ${currentLevel.cardClass} shadow-sm`}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base font-semibold">Niveau createur visible</CardTitle>
            <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${currentLevel.accentClass} ${shareBurst ? "badge-pop" : ""}`}>
              {currentLevel.label}
            </span>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-2xl border border-white/70 bg-white/80 px-4 py-3">
              <p className="text-xs text-gray-500">Score actuel</p>
              <p className="mt-1 text-2xl font-black text-black">{reputationScore}</p>
              <div className="mt-3 h-2 rounded-full bg-gray-100">
                <div
                  className="h-2 rounded-full bg-black transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-gray-600">
                {next
                  ? `Encore ${pointsToNext} points pour passer au niveau ${next.label}.`
                  : "Niveau maximal atteint. Continue pour garder ton avance."}
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-2xl border border-gray-100 bg-white px-3 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Badge principal</p>
                {primaryBadge ? (
                  <div className={`mt-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 ${shareBurst ? "badge-pop" : ""}`}>
                    <p className="text-sm font-semibold text-amber-700">{primaryBadge.label}</p>
                    <p className="mt-1 text-xs text-amber-700/85">{primaryBadge.description}</p>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-gray-500">
                    Aucun badge debloque pour l'instant. Continue les cycles pour en activer.
                  </p>
                )}
              </div>
              <div className="rounded-2xl border border-gray-100 bg-white px-3 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Message dynamique</p>
                <p className="mt-2 text-sm font-semibold text-black">{dynamicMessage}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            label="Gains createur (reels)"
            value={formatXOF(dashboardQuery.data?.dashboard.stats.totalEarnings ?? 0)}
            icon={<Coins className="h-4 w-4" />}
          />
          <MetricCard
            label="Membres dans tes tontines"
            value={`${totalMembersInTontines}`}
            icon={<Users className="h-4 w-4" />}
          />
          <MetricCard
            label="Tontines creees"
            value={`${totalTontines}`}
            icon={<TrendingUp className="h-4 w-4" />}
          />
          <MetricCard
            label="Volume communaute"
            value={formatXOF(dashboardQuery.data?.dashboard.stats.totalVolume ?? 0)}
            icon={<Coins className="h-4 w-4" />}
          />
        </section>

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold">Money focus</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className={`rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-4 ${shareBurst || dailyGain > 0 ? "gain-pulse" : ""}`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Aujourd'hui tu as gagne</p>
              <p className="mt-1 text-3xl font-black tracking-tight text-emerald-800">{formatXOF(mainMoneyValue)}</p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded-2xl border border-gray-100 bg-white px-3 py-3">
                <p className="text-xs text-gray-500">Total genere</p>
                <p className="mt-1 text-lg font-bold text-black">{formatXOF(totalGenerated)}</p>
              </div>
              <div className="rounded-2xl border border-gray-100 bg-white px-3 py-3">
                <p className="text-xs text-gray-500">Projection 100 membres</p>
                <p className="mt-1 text-lg font-bold text-black">{formatXOF(hundredMembersVisual)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold">Gamification performance</CardTitle>
            <Trophy className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            {reputationQuery.isLoading ? (
              <SkeletonCard rows={2} className="bg-transparent px-0 py-0 shadow-none border-none" />
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-xl border border-gray-100 bg-white px-3 py-2.5 text-center">
                    <p className="text-gray-500">Score</p>
                    <p className="font-bold text-gray-900">{reputationQuery.data?.score ?? 0}</p>
                  </div>
                  <div className="rounded-xl border border-gray-100 bg-white px-3 py-2.5 text-center">
                    <p className="text-gray-500">Tier</p>
                    <p className="font-bold text-gray-900">{reputationQuery.data?.tier ?? "new"}</p>
                  </div>
                  <div className="rounded-xl border border-gray-100 bg-white px-3 py-2.5 text-center">
                    <p className="text-gray-500">Badges</p>
                    <p className="font-bold text-gray-900">{reputationQuery.data?.badgeCount ?? 0}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(reputationQuery.data?.badges ?? []).slice(0, 4).map((badge) => (
                    <span
                      key={badge.badge}
                      className="rounded-full border border-amber-100 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700"
                    >
                      {badge.label}
                    </span>
                  ))}
                  {(reputationQuery.data?.badges ?? []).length === 0 ? (
                    <span className="text-xs text-gray-500">
                      Les badges apparaîtront après progression continue des cycles.
                    </span>
                  ) : null}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold">
              Revenus generes par tontine
            </CardTitle>
            <Link href="/tontine">
              <Button className="press-feedback rounded-xl bg-black text-white hover:bg-black/90">
                Creer une tontine et gagner de l'argent
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {dashboardQuery.isLoading || poolsQuery.isLoading ? (
              <SkeletonCard rows={5} className="bg-transparent px-0 py-0 shadow-none border-none" />
            ) : topRows.length === 0 ? (
              <EmptyHint
                title="Aucune tontine reliee a tes communautes"
                description="Cree une tontine et active le mode createur pour monetiser les contributions."
                action={
                  <Link href="/tontine">
                    <Button className="press-feedback rounded-xl bg-black text-white hover:bg-black/90">
                      Creer une tontine
                    </Button>
                  </Link>
                }
              />
            ) : (
              topRows.map((row) => (
                <Link key={row.id} href={`/tontine/${row.id}`}>
                  <div className="premium-hover cursor-pointer rounded-2xl border border-gray-100 bg-white px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-black">{row.name}</p>
                        <p className="mt-1 text-xs text-gray-500">
                          {row.communityName} • {row.memberCount} membres • statut {row.status}
                        </p>
                        <p className="mt-1 text-xs text-gray-500">
                          Cotisation: {formatXOF(row.contributionAmount)} • Taux: {row.creatorFeeRate.toFixed(0)}%
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                          Gain creeateur
                        </p>
                        <p className="text-sm font-bold text-emerald-700">
                          {formatXOF(row.estimatedCreatorRevenue)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                      Total contribue (endpoint /tontines/:id): {formatXOF(row.totalContributed)}
                    </div>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold">Top createurs (pression sociale)</CardTitle>
            <Sparkles className="h-4 w-4 text-gray-500" />
          </CardHeader>
          <CardContent className="space-y-2">
            {rankingQuery.isLoading ? (
              <SkeletonCard rows={3} className="bg-transparent px-0 py-0 shadow-none border-none" />
            ) : rankingRows.length === 0 ? (
              <EmptyHint
                title="Classement indisponible"
                description="Le classement se mettra a jour automatiquement quand plus de donnees seront visibles."
              />
            ) : (
              rankingRows.map((row, index) => (
                <div key={row.id} className="premium-hover rounded-2xl border border-gray-100 bg-white px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-black">
                        #{index + 1} {row.label}
                        {row.isYou ? " • toi" : ""}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Earnings {formatXOF(row.earnings)} • Membres {row.members} • Score {row.score}
                      </p>
                    </div>
                    <div className="rounded-full bg-black px-2.5 py-1 text-xs font-semibold text-white">
                      {row.points} pts
                    </div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold">Inviter des membres</CardTitle>
            <Share2 className="h-4 w-4 text-gray-500" />
          </CardHeader>
          <CardContent className="space-y-3">
            {topRows.length === 0 ? (
              <EmptyHint
                title="Aucune tontine à partager"
                description="Crée une tontine puis active le mode créateur pour lancer ta boucle virale."
              />
            ) : (
              <>
                <p className="text-xs text-gray-500">
                  Chaque personne que tu ajoutes te rapporte {inviteTarget?.creatorFeeRate.toFixed(0)}% sur les collectes.
                </p>
                <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-700">
                  <p className="font-semibold text-black">Tu as invite {invitedCount} personnes</p>
                  <p className="mt-0.5">
                    Invite 10 personnes de plus pour viser {formatXOF(nextInviteGoal)} de gain potentiel.
                  </p>
                </div>
                <select
                  value={inviteTarget?.id ?? ""}
                  onChange={(event) => setSelectedTontineId(event.target.value)}
                  className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm"
                >
                  {topRows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name} ({row.memberCount} membres)
                    </option>
                  ))}
                </select>
                <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600 break-all">
                  {inviteLink}
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-xl border border-gray-100 bg-white px-3 py-2 text-center">
                    <p className="text-gray-500">Membres</p>
                    <p className="font-bold text-gray-900">{inviteTarget?.memberCount ?? 0}</p>
                  </div>
                  <div className="rounded-xl border border-gray-100 bg-white px-3 py-2 text-center">
                    <p className="text-gray-500">Gains estimes</p>
                    <p className="font-bold text-emerald-700">{formatXOF(inviteTarget?.estimatedCreatorRevenue ?? 0)}</p>
                  </div>
                  <div className="rounded-xl border border-gray-100 bg-white px-3 py-2 text-center">
                    <p className="text-gray-500">Gains reels</p>
                    <p className="font-bold text-gray-900">{formatXOF(inviteTarget?.estimatedCreatorRevenue ?? 0)}</p>
                  </div>
                </div>
                <Button
                  className={`press-feedback w-full rounded-xl bg-black text-white hover:bg-black/90 ${shareBurst ? "gain-pulse" : ""}`}
                  onClick={async () => {
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
                    setShareDailyCountMap((currentMap) => {
                      const nextValue = (currentMap[today] ?? 0) + 1;
                      const nextMap = { ...currentMap, [today]: nextValue };
                      if (typeof window !== "undefined") {
                        try {
                          window.localStorage.setItem(SHARE_DAILY_COUNT_KEY, JSON.stringify(nextMap));
                        } catch {
                          // ignore storage failures
                        }
                      }
                      return nextMap;
                    });
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
                >
                  <Copy className="h-4 w-4" />
                  Partager ma tontine
                </Button>
                <p className="text-[11px] text-gray-500">
                  Partages copies: {shareCount}. Feedback instantane actif (toast + animation).
                </p>
              </>
            )}
          </CardContent>
        </Card>

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

function MetricCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="premium-card premium-hover rounded-2xl border-black/5 shadow-sm">
      <CardContent className="space-y-1.5 p-4">
        <div className="text-gray-500">{icon}</div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</p>
        <p className="text-sm font-semibold text-black">{value}</p>
      </CardContent>
    </Card>
  );
}
