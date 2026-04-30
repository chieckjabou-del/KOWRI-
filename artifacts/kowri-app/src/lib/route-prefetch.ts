const prefetchedRoutes = new Set<string>();

function normalizeRoute(route: string): string {
  if (!route.startsWith("/")) return `/${route}`;
  return route;
}

function routeImport(route: string): Promise<unknown> | null {
  switch (normalizeRoute(route)) {
    case "/dashboard":
      return import("@/pages/DashboardHome");
    case "/wallet":
      return import("@/pages/WalletHome");
    case "/tontine":
      return import("@/pages/TontineHome");
    case "/creator":
      return import("@/pages/Creator");
    case "/creator-dashboard":
      return import("@/pages/CreatorDashboard");
    default:
      return null;
  }
}

export function prefetchRoute(route: string): void {
  const normalized = normalizeRoute(route);
  if (prefetchedRoutes.has(normalized)) return;
  const loader = routeImport(normalized);
  if (!loader) return;
  prefetchedRoutes.add(normalized);
  loader.catch(() => {
    prefetchedRoutes.delete(normalized);
  });
}

export function prefetchPrimaryRoutes(): void {
  prefetchRoute("/dashboard");
  prefetchRoute("/wallet");
  prefetchRoute("/tontine");
  prefetchRoute("/creator");
  prefetchRoute("/creator-dashboard");
}

function canUseAggressivePrefetch(): boolean {
  if (typeof navigator === "undefined") return true;
  const connection = (
    navigator as Navigator & {
      connection?: { effectiveType?: string; saveData?: boolean };
    }
  ).connection;
  if (!connection) return true;
  if (connection.saveData) return false;
  return connection.effectiveType !== "slow-2g" && connection.effectiveType !== "2g";
}

export function warmupPrimaryRoutesOnIdle(): () => void {
  if (typeof window === "undefined") return () => {};
  if (!canUseAggressivePrefetch()) return () => {};

  const run = () => prefetchPrimaryRoutes();

  if ("requestIdleCallback" in window) {
    const id = window.requestIdleCallback(run, { timeout: 2500 });
    return () => window.cancelIdleCallback(id);
  }

  const timeoutId = setTimeout(run, 1200);
  return () => clearTimeout(timeoutId);
}
