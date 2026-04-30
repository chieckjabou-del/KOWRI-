import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import {
  getCommunityPools,
  getCreatorDashboard,
  getCreatorReputationProfile,
  getCreatorReputationSnapshot,
  getTontineContributionSnapshot,
  listCreatorCommunities,
  readCreatorDailyEarning,
} from "@/services/api/creatorService";
import { makeCacheKey, readCachedValue, writeCachedValue } from "@/lib/localCache";
import { DATA_TTL_MS } from "@/lib/cachePolicy";

export interface CreatorTontineRevenueRow {
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

export interface CreatorRankingRow {
  id: string;
  label: string;
  earnings: number;
  members: number;
  score: number;
  points: number;
  isYou?: boolean;
}

export interface RetentionState {
  lastActiveDate: string;
  streak: number;
}

export interface DailyGoal {
  id: "share" | "members" | "earnings";
  label: string;
  progress: number;
  target: number;
  done: boolean;
}

export interface LevelConfig {
  key: "bronze" | "silver" | "gold";
  label: string;
  minScore: number;
  maxScore: number;
  accentClass: string;
  cardClass: string;
}

export interface CreatorBadge {
  badge: string;
  label: string;
  description: string;
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

export function persistShareDailyCount(
  setShareDailyCountMap: React.Dispatch<React.SetStateAction<Record<string, number>>>,
  dayKey: string,
): void {
  setShareDailyCountMap((currentMap) => {
    const nextValue = (currentMap[dayKey] ?? 0) + 1;
    const nextMap = { ...currentMap, [dayKey]: nextValue };
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(SHARE_DAILY_COUNT_KEY, JSON.stringify(nextMap));
      } catch {
        // ignore storage failures
      }
    }
    return nextMap;
  });
}

function canonicalTier(rawTier: string | undefined): string {
  const value = (rawTier ?? "").toLowerCase();
  if (value.includes("gold")) return "gold";
  if (value.includes("silver")) return "silver";
  if (value.includes("bronze")) return "bronze";
  return "bronze";
}

function levelFromScore(score: number): LevelConfig {
  return LEVELS.find((item) => score >= item.minScore && score <= item.maxScore) ?? LEVELS[0];
}

function nextLevel(currentLevel: LevelConfig): LevelConfig | null {
  const currentIndex = LEVELS.findIndex((item) => item.key === currentLevel.key);
  if (currentIndex < 0 || currentIndex === LEVELS.length - 1) return null;
  return LEVELS[currentIndex + 1];
}

function pickPrimaryBadge(
  badges: CreatorBadge[],
): CreatorBadge | null {
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

export function useCreatorDashboardData() {
  const { token, user } = useAuth();
  const creatorCacheKey = makeCacheKey("creator-dashboard", user?.id);
  const cachedCreator =
    readCachedValue<{
      dashboard: Awaited<ReturnType<typeof getCreatorDashboard>>["dashboard"];
      rows: CreatorTontineRevenueRow[];
      rankingRows: CreatorRankingRow[];
    }>(creatorCacheKey, DATA_TTL_MS.CREATOR_DASHBOARD)?.data ?? null;
  const [selectedTontineId, setSelectedTontineId] = useState("");
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
    initialData: cachedCreator ? { dashboard: cachedCreator.dashboard, usingMock: false } : undefined,
    placeholderData: cachedCreator ? { dashboard: cachedCreator.dashboard, usingMock: false } : undefined,
    staleTime: 15_000,
    gcTime: 600_000,
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
          const memberCount = Number(rawTontine.memberCount ?? snap?.memberCount ?? 0);
          const contributionAmount = Number(rawTontine.contributionAmount ?? snap?.contributionAmount ?? 0);
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
            estimatedCreatorRevenue: totalContributed * (creatorFeeRate / 100),
            creatorFeeRate,
            status: typeof rawTontine.status === "string" ? rawTontine.status : "pending",
          });
        }
      }
      return rows;
    },
    initialData: cachedCreator?.rows ?? undefined,
    placeholderData: cachedCreator?.rows ?? undefined,
    staleTime: 20_000,
    gcTime: 600_000,
  });

  const reputationQuery = useQuery({
    queryKey: ["creator-reputation-profile", user?.id],
    enabled: Boolean(user?.id),
    queryFn: () => getCreatorReputationProfile(token, user!.id),
    retry: false,
  });

  const rankingQuery = useQuery({
    queryKey: [
      "creator-top-ranking-local",
      user?.id,
      dashboardQuery.data?.dashboard.stats.totalEarnings ?? 0,
      dashboardQuery.data?.dashboard.stats.totalMembers ?? 0,
    ],
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
    initialData: cachedCreator?.rankingRows ?? undefined,
    placeholderData: cachedCreator?.rankingRows ?? undefined,
    staleTime: 45_000,
    gcTime: 600_000,
  });

  const rows = poolsQuery.data ?? [];
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
    if (typeof window === "undefined") return `/tontine/${inviteTarget.id}?${params.toString()}`;
    return `${window.location.origin}/tontine/${inviteTarget.id}?${params.toString()}`;
  }, [inviteTarget]);

  const today = todayIsoDate();
  const yesterday = yesterdayIsoDate();
  const shareToday = shareDailyCountMap[today] ?? 0;
  const invitedCount = inviteTarget?.memberCount ?? 0;
  const inviteTargetGain = (inviteTarget?.contributionAmount ?? 0) * ((inviteTarget?.creatorFeeRate ?? 0) / 100);
  const nextInviteGoal = inviteTargetGain * 10;
  const dailyGain = useMemo(() => readCreatorDailyEarning(), []);
  const totalGenerated = dashboardQuery.data?.dashboard.stats.totalEarnings ?? 0;
  const mainMoneyValue = dailyGain > 0 ? dailyGain : totalGenerated;
  const dailyGoals: DailyGoal[] = [
    {
      id: "share",
      label: "Partager 3 fois ta tontine",
      progress: shareToday,
      target: 3,
      done: shareToday >= 3,
    },
    {
      id: "members",
      label: "Atteindre 5 membres invites",
      progress: invitedCount,
      target: 5,
      done: invitedCount >= 5,
    },
    {
      id: "earnings",
      label: "Generer 10 000 XOF aujourd'hui",
      progress: mainMoneyValue,
      target: 10000,
      done: mainMoneyValue >= 10000,
    },
  ];
  const goalsCompleted = dailyGoals.filter((goal) => goal.done).length;

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
  const nextLevelLabel = next ? next.label : null;
  const primaryBadge = pickPrimaryBadge((reputationQuery.data?.badges ?? []) as CreatorBadge[]);
  const dynamicMessage =
    currentLevel.key === "gold"
      ? "Les createurs niveau Gold gagnent plus et attirent plus de membres."
      : currentLevel.key === "silver"
        ? "Encore une poussee et tu passes Gold pour augmenter ta traction."
        : "Passe Silver rapidement pour accelerer ta credibilite createur.";

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

  const rankingRows = rankingQuery.data ?? [];

  useEffect(() => {
    if (!dashboardQuery.data?.dashboard) return;
    writeCachedValue(creatorCacheKey, {
      dashboard: dashboardQuery.data.dashboard,
      rows: topRows,
      rankingRows,
    });
  }, [creatorCacheKey, dashboardQuery.data?.dashboard, rankingRows, topRows]);

  return {
    token,
    user,
    selectedTontineId,
    setSelectedTontineId,
    shareCount,
    setShareCount,
    retentionState,
    shareDailyCountMap,
    setShareDailyCountMap,
    dashboardQuery,
    poolsQuery,
    reputationQuery,
    rankingQuery,
    rankingRows,
    communities,
    rows,
    topRows,
    inviteTarget,
    inviteLink,
    totalTontines,
    totalMembersInTontines,
    averageFeeRate,
    hundredMembersVisual,
    currentLevel,
    progressPercent,
    pointsToNext,
    nextLevelLabel,
    primaryBadge,
    dynamicMessage,
    dailyGain,
    totalGenerated,
    mainMoneyValue,
    dailyGoals,
    goalsCompleted,
    invitedCount,
    nextInviteGoal,
    today,
    shareToday,
  };
}
