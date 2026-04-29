import { ApiError, apiFetch } from "@/lib/api";
import type { CreatorCommunity, CreatorDashboard } from "@/types/akwe";

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function mapCommunity(row: Record<string, unknown>): CreatorCommunity {
  return {
    id: asString(row.id),
    name: asString(row.name, "Communaute"),
    description: row.description ? asString(row.description) : null,
    creatorId: asString(row.creatorId),
    handle: asString(row.handle),
    memberCount: asNumber(row.memberCount, 0),
    walletId: row.walletId ? asString(row.walletId) : null,
    // Backend stores percentage points already (e.g. 5 means 5%)
    platformFeeRate: asNumber(row.platformFeeRate, 2),
    creatorFeeRate: asNumber(row.creatorFeeRate, 5),
    totalVolume: asNumber(row.totalVolume, 0),
    status: asString(row.status, "active"),
  };
}

export async function getCreatorDashboard(
  token: string | null,
  creatorId: string,
): Promise<{ dashboard: CreatorDashboard; usingMock: boolean }> {
  const data = await apiFetch<{ communities?: unknown[]; stats?: unknown }>(
    `/creator/dashboard/${encodeURIComponent(creatorId)}`,
    token,
  );
  const communities = (data.communities ?? []).map((row) =>
    mapCommunity(row as Record<string, unknown>),
  );
  const statsRaw = (data.stats ?? {}) as Record<string, unknown>;
  return {
    dashboard: {
      communities,
      stats: {
        totalCommunities: asNumber(statsRaw.totalCommunities, communities.length),
        totalMembers: asNumber(statsRaw.totalMembers, 0),
        totalVolume: asNumber(statsRaw.totalVolume, 0),
        totalEarnings: asNumber(statsRaw.totalEarnings, 0),
      },
    },
    usingMock: false,
  };
}

export async function listCreatorCommunities(
  token: string | null,
): Promise<{ communities: CreatorCommunity[]; usingMock: boolean }> {
  const data = await apiFetch<{ communities?: unknown[] }>(
    "/creator/communities?limit=50",
    token,
  );
  const communities = (data.communities ?? []).map((row) =>
    mapCommunity(row as Record<string, unknown>),
  );
  return { communities, usingMock: false };
}

export async function distributeCommunityEarnings(
  token: string | null,
  communityId: string,
  transactionAmount: number,
  creatorFeeRatePercent = 5,
): Promise<{
  platformFee: number;
  creatorFee: number;
  usingMock: boolean;
}> {
  const data = await apiFetch<Record<string, unknown>>(
    `/creator/communities/${encodeURIComponent(communityId)}/earnings`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ transactionAmount, currency: "XOF" }),
    },
  );
  const creatorRate = creatorFeeRatePercent / 100;
  return {
    platformFee: asNumber(data.platformFee, transactionAmount * 0.02),
    creatorFee: asNumber(data.creatorFee, transactionAmount * creatorRate),
    usingMock: false,
  };
}

export async function createCommunity(
  token: string | null,
  input: {
    name: string;
    handle: string;
    description?: string;
    creatorId: string;
    creatorFeeRate: number;
    platformFeeRate?: number;
  },
): Promise<{ community: CreatorCommunity; usingMock: boolean }> {
  const data = await apiFetch<Record<string, unknown>>("/creator/communities", token, {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      handle: input.handle,
      description: input.description ?? null,
      creatorId: input.creatorId,
      creatorFeeRate: input.creatorFeeRate,
      platformFeeRate: input.platformFeeRate ?? 2,
    }),
  });
  return { community: mapCommunity(data), usingMock: false };
}

export async function joinCommunity(
  token: string | null,
  communityId: string,
  userId: string,
): Promise<void> {
  await apiFetch(`/creator/communities/${encodeURIComponent(communityId)}/join`, token, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

export async function getCommunityDetail(
  token: string | null,
  idOrHandle: string,
): Promise<{ community: CreatorCommunity | null; usingMock: boolean }> {
  try {
    const data = await apiFetch<Record<string, unknown>>(
      `/creator/communities/${encodeURIComponent(idOrHandle)}`,
      token,
    );
    return { community: mapCommunity(data), usingMock: false };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { community: null, usingMock: false };
    }
    throw error;
  }
}

export async function getCommunityPools(
  token: string | null,
  communityId: string,
): Promise<{ investmentPools: Record<string, unknown>[]; tontines: Record<string, unknown>[]; usingMock: boolean }> {
  const data = await apiFetch<Record<string, unknown>>(
    `/creator/communities/${encodeURIComponent(communityId)}/pools`,
    token,
  );
  return {
    investmentPools: (data.investmentPools as Record<string, unknown>[] | undefined) ?? [],
    tontines: (data.tontines as Record<string, unknown>[] | undefined) ?? [],
    usingMock: false,
  };
}

export interface TontineContributionSnapshot {
  id: string;
  name: string;
  status: string;
  tontineType: string;
  memberCount: number;
  maxMembers: number;
  currentRound: number;
  contributionAmount: number;
  totalContributed: number;
}

export async function getTontineContributionSnapshot(
  token: string | null,
  tontineId: string,
): Promise<TontineContributionSnapshot> {
  const row = await apiFetch<Record<string, unknown>>(
    `/tontines/${encodeURIComponent(tontineId)}`,
    token,
  );
  return {
    id: asString(row.id, tontineId),
    name: asString(row.name, "Tontine"),
    status: asString(row.status, "pending"),
    tontineType: asString(row.tontineType, "classic"),
    memberCount: asNumber(row.memberCount, 0),
    maxMembers: asNumber(row.maxMembers, 0),
    currentRound: asNumber(row.currentRound, 0),
    contributionAmount: asNumber(row.contributionAmount, 0),
    totalContributed: asNumber(row.totalContributed, 0),
  };
}

export interface CreatorModeLink {
  communityId: string;
  creatorFeeRate: number;
  communityName?: string;
}

function creatorModeLinkKey(tontineId: string): string {
  return `akwe-creator-mode-link-${tontineId}`;
}

export function saveCreatorModeLink(tontineId: string, link: CreatorModeLink): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(creatorModeLinkKey(tontineId), JSON.stringify(link));
  } catch {
    // ignore storage failures
  }
}

export function loadCreatorModeLink(tontineId: string): CreatorModeLink | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(creatorModeLinkKey(tontineId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const communityId = asString(parsed.communityId);
    if (!communityId) return null;
    return {
      communityId,
      creatorFeeRate: asNumber(parsed.creatorFeeRate, 5),
      communityName: parsed.communityName ? asString(parsed.communityName) : undefined,
    };
  } catch {
    return null;
  }
}

export interface CreatorReputationBadge {
  badge: string;
  label: string;
  description: string;
  earnedAt?: string;
}

export interface CreatorReputationProfile {
  score: number;
  tier: string;
  badgeCount: number;
  badges: CreatorReputationBadge[];
}

export async function getCreatorReputationProfile(
  token: string | null,
  userId: string,
): Promise<CreatorReputationProfile> {
  async function loadBadges(): Promise<Record<string, unknown>> {
    return apiFetch<Record<string, unknown>>(
      `/community/reputation/${encodeURIComponent(userId)}/badges`,
      token,
    );
  }

  try {
    const data = await loadBadges();
    return {
      score: asNumber(data.score, 0),
      tier: asString(data.tier, "new"),
      badgeCount: asNumber(data.badgeCount, 0),
      badges: Array.isArray(data.badges)
        ? data.badges
            .map((row) => row as Record<string, unknown>)
            .map((row) => ({
              badge: asString(row.badge),
              label: asString(row.label, asString(row.badge, "Badge")),
              description: asString(row.description, ""),
              earnedAt: row.earnedAt ? asString(row.earnedAt) : undefined,
            }))
            .filter((row) => row.badge)
        : [],
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // If reputation wasn't computed yet, trigger existing backend computation then retry badges.
      await apiFetch(
        `/community/reputation/${encodeURIComponent(userId)}/compute`,
        token,
        { method: "POST" },
      ).catch(() => undefined);
      const data = await loadBadges().catch(() => ({} as Record<string, unknown>));
      return {
        score: asNumber(data.score, 0),
        tier: asString(data.tier, "new"),
        badgeCount: asNumber(data.badgeCount, 0),
        badges: Array.isArray(data.badges)
          ? data.badges
              .map((row) => row as Record<string, unknown>)
              .map((row) => ({
                badge: asString(row.badge),
                label: asString(row.label, asString(row.badge, "Badge")),
                description: asString(row.description, ""),
                earnedAt: row.earnedAt ? asString(row.earnedAt) : undefined,
              }))
              .filter((row) => row.badge)
          : [],
      };
    }
    throw error;
  }
}
