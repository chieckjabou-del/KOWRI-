export type CacheScope =
  | "wallet-summary"
  | "wallet-transactions"
  | "dashboard"
  | "tontines-mine"
  | "tontines-public"
  | "creator-dashboard"
  | "creator-ranking"
  | "creator-reputation"
  | "generic";

const SHORT = 90_000;
const MEDIUM = 5 * 60_000;
const LONG = 12 * 60_000;

export function ttlForScope(scope: CacheScope): number {
  switch (scope) {
    case "wallet-summary":
      return SHORT;
    case "wallet-transactions":
      return SHORT;
    case "dashboard":
      return MEDIUM;
    case "tontines-mine":
      return MEDIUM;
    case "tontines-public":
      return 3 * 60_000;
    case "creator-dashboard":
      return MEDIUM;
    case "creator-ranking":
      return 4 * 60_000;
    case "creator-reputation":
      return LONG;
    default:
      return MEDIUM;
  }
}

export function invalidateForAction(action: "collect" | "send" | "deposit", userId?: string | null): string[] {
  const uid = userId ?? "anon";
  if (action === "send" || action === "deposit") {
    return [
      `akwe-cache:wallet-summary:${uid}`,
      `akwe-cache:wallet-transactions:${uid}`,
      `akwe-cache:dashboard:${uid}:wallet`,
      `akwe-cache:dashboard:${uid}:tx`,
    ];
  }
  return [
    `akwe-cache:tontines-mine:${uid}`,
    `akwe-cache:dashboard:${uid}:tontines`,
    `akwe-cache:creator-dashboard:${uid}`,
    `akwe-cache:creator-ranking:${uid}`,
  ];
}
