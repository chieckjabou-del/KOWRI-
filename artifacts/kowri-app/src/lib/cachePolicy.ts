import { invalidateCache, makeCacheKey } from "@/lib/localCache";

type DataKind =
  | "wallet-summary"
  | "wallet-transactions"
  | "dashboard"
  | "tontines-list"
  | "tontines-public"
  | "creator-dashboard"
  | "creator-ranking"
  | "creator-reputation";

export const CACHE_TTL_MS = {
  walletSummary: 90_000,
  walletTransactions: 90_000,
} as const;

export const DATA_TTL_MS = {
  DASHBOARD: 5 * 60_000,
  TONTINE_LIST: 5 * 60_000,
  TONTINE_PUBLIC: 3 * 60_000,
  CREATOR_DASHBOARD: 5 * 60_000,
  CREATOR_RANKING: 4 * 60_000,
  CREATOR_REPUTATION: 10 * 60_000,
} as const;

export function getCacheTtlMs(kind: DataKind): number {
  switch (kind) {
    case "wallet-summary":
      return CACHE_TTL_MS.walletSummary;
    case "wallet-transactions":
      return CACHE_TTL_MS.walletTransactions;
    case "dashboard":
      return DATA_TTL_MS.DASHBOARD;
    case "tontines-list":
      return DATA_TTL_MS.TONTINE_LIST;
    case "tontines-public":
      return DATA_TTL_MS.TONTINE_PUBLIC;
    case "creator-dashboard":
      return DATA_TTL_MS.CREATOR_DASHBOARD;
    case "creator-ranking":
      return DATA_TTL_MS.CREATOR_RANKING;
    case "creator-reputation":
      return DATA_TTL_MS.CREATOR_REPUTATION;
    default:
      return DATA_TTL_MS.DASHBOARD;
  }
}

export function getCacheMaxAgeMs(kind: DataKind): number {
  return getCacheTtlMs(kind);
}

type CriticalAction = "collect" | "send" | "deposit" | "join" | "create-tontine";

export function invalidateCacheByMutation(action: CriticalAction, userId?: string | null): void {
  const uid = userId ?? null;
  switch (action) {
    case "send":
    case "deposit":
      if (uid) {
        invalidateCache(makeCacheKey("wallet-home", uid));
        invalidateCache(`${makeCacheKey("wallet-home", uid)}:tx`);
      }
      invalidateCache(`${makeCacheKey("dashboard", uid)}:wallet`);
      invalidateCache(`${makeCacheKey("dashboard", uid)}:tx`);
      break;
    case "collect":
    case "join":
    case "create-tontine":
      invalidateCache("cache:tontines:public");
      if (uid) {
        invalidateCache(`cache:tontines:mine:${uid}`);
      }
      invalidateCache(`${makeCacheKey("dashboard", uid)}:tontines`);
      invalidateCache(makeCacheKey("creator-dashboard", uid));
      break;
    default:
      break;
  }
}
