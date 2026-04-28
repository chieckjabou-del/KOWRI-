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

function mockDashboard(): CreatorDashboard {
  return {
    communities: [
      {
        id: "mock-community",
        name: "Akwé Leaders",
        description: "Communaute demo connectee au mode fallback",
        creatorId: "mock-creator",
        handle: "akweleaders",
        memberCount: 38,
        walletId: "mock-wallet",
        platformFeeRate: 2,
        creatorFeeRate: 5,
        totalVolume: 2500000,
        status: "active",
      },
    ],
    stats: {
      totalCommunities: 1,
      totalMembers: 38,
      totalVolume: 2500000,
      totalEarnings: 125000,
    },
  };
}

export async function getCreatorDashboard(
  token: string | null,
  creatorId: string,
): Promise<{ dashboard: CreatorDashboard; usingMock: boolean }> {
  try {
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
  } catch (error) {
    if (error instanceof ApiError) {
      return { dashboard: mockDashboard(), usingMock: true };
    }
    throw error;
  }
}

export async function listCreatorCommunities(
  token: string | null,
): Promise<{ communities: CreatorCommunity[]; usingMock: boolean }> {
  try {
    const data = await apiFetch<{ communities?: unknown[] }>(
      "/creator/communities?limit=50",
      token,
    );
    const communities = (data.communities ?? []).map((row) =>
      mapCommunity(row as Record<string, unknown>),
    );
    if (communities.length === 0) {
      return { communities: mockDashboard().communities, usingMock: true };
    }
    return { communities, usingMock: false };
  } catch (error) {
    if (error instanceof ApiError) {
      return { communities: mockDashboard().communities, usingMock: true };
    }
    throw error;
  }
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
  try {
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
  } catch (error) {
    if (error instanceof ApiError) {
      const creatorRate = creatorFeeRatePercent / 100;
      return {
        platformFee: transactionAmount * 0.02,
        creatorFee: transactionAmount * creatorRate,
        usingMock: true,
      };
    }
    throw error;
  }
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
  try {
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
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        community: {
          id: `mock-community-${Date.now()}`,
          name: input.name,
          description: input.description ?? null,
          creatorId: input.creatorId,
          handle: input.handle,
          memberCount: 1,
          walletId: "mock-wallet",
          platformFeeRate: 2,
          creatorFeeRate: input.creatorFeeRate,
          totalVolume: 0,
          status: "active",
        },
        usingMock: true,
      };
    }
    throw error;
  }
}

export async function joinCommunity(
  token: string | null,
  communityId: string,
  userId: string,
): Promise<void> {
  try {
    await apiFetch(`/creator/communities/${encodeURIComponent(communityId)}/join`, token, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return;
    }
    throw error;
  }
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
    if (error instanceof ApiError) {
      return {
        community: {
          id: `mock-${idOrHandle || "community"}`,
          name: "Communaute Akwé (simulation)",
          description: "Fallback frontend quand le endpoint detail est indisponible.",
          creatorId: "mock-creator",
          handle: idOrHandle || "akwe-community",
          memberCount: 24,
          walletId: "mock-wallet",
          platformFeeRate: 2,
          creatorFeeRate: 5,
          totalVolume: 1800000,
          status: "active",
        },
        usingMock: true,
      };
    }
    throw error;
  }
}

export async function getCommunityPools(
  token: string | null,
  communityId: string,
): Promise<{ investmentPools: Record<string, unknown>[]; tontines: Record<string, unknown>[]; usingMock: boolean }> {
  try {
    const data = await apiFetch<Record<string, unknown>>(
      `/creator/communities/${encodeURIComponent(communityId)}/pools`,
      token,
    );
    return {
      investmentPools: (data.investmentPools as Record<string, unknown>[] | undefined) ?? [],
      tontines: (data.tontines as Record<string, unknown>[] | undefined) ?? [],
      usingMock: false,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        investmentPools: [],
        tontines: [],
        usingMock: true,
      };
    }
    throw error;
  }
}
