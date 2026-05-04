import { apiFetch } from "@/lib/api";

export type FounderSeriesPoint = {
  date: string;
  newUsers?: number;
  activatedUsers?: number;
};

export type FounderTxTypeBreakdown = {
  type: string;
  count: number;
  volume: number;
};

export type FounderMvpData = {
  period: string;
  generatedAt: string;
  founderGuardOpen: boolean;
  kpis: {
    activationRate: number;
    walletAdoptionRate: number;
    txSuccessRate: number;
    repeatUserRate: number;
    wauMauProxy: number;
    savingsStickiness: number;
    avgFirstValueHours: number;
    avgTontineFillRate: number;
  };
  totals: {
    totalUsers: number;
    newUsersInPeriod: number;
    walletsAdopted: number;
    activeTontines: number;
    transactionsCompleted: number;
    transactionVolume: number;
    activeSavingsUsers: number;
  };
  series: {
    newUsers: FounderSeriesPoint[];
    activatedUsers: FounderSeriesPoint[];
  };
  breakdowns: {
    txByType: FounderTxTypeBreakdown[];
  };
};

export async function getFounderMvp(
  token: string | null,
  period: "7d" | "30d" | "90d" = "30d",
): Promise<FounderMvpData> {
  return apiFetch<FounderMvpData>(`/founder/mvp?period=${period}`, token, {
    policy: { retries: 0, dedupeKey: `founder-mvp:${period}` },
  });
}
