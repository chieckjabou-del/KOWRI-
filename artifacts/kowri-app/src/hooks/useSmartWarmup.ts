import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { getPrimaryWallet } from "@/services/api/walletService";
import { listUserTontines } from "@/services/api/tontineService";
import { getCreatorDashboard } from "@/services/api/creatorService";
import { listPublicTontines } from "@/services/api/tontineService";

type WarmupEntry<T> = {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
};

function canWarmupNetwork(): boolean {
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

export function useSmartWarmup(entries: WarmupEntry<unknown>[], enabled = true): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (!canWarmupNetwork()) return;

    const run = () => {
      for (const entry of entries) {
        queryClient
          .prefetchQuery({
            queryKey: entry.queryKey,
            queryFn: entry.queryFn,
            staleTime: 60_000,
          })
          .catch(() => undefined);
      }
    };

    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(run, { timeout: 2800 });
      return () => window.cancelIdleCallback(id);
    }

    const timeoutId = setTimeout(run, 1300);
    return () => clearTimeout(timeoutId);
  }, [enabled, entries, queryClient]);
}

type WarmupPreset = "app" | "creator" | "tontine-home";

export function useNamedSmartWarmup(
  preset: WarmupPreset,
  enabled = true,
): void {
  const { token, user } = useAuth();
  const entries = useMemo(() => {
    if (!user?.id) return [] as WarmupEntry<unknown>[];
    if (preset === "creator") {
      return [
        {
          queryKey: ["creator-dashboard-machine", user.id],
          queryFn: () => getCreatorDashboard(token, user.id),
        },
      ] satisfies WarmupEntry<unknown>[];
    }
    if (preset === "tontine-home") {
      return [
        {
          queryKey: ["akwe-tontines", user.id],
          queryFn: () => listUserTontines(token),
        },
        {
          queryKey: ["akwe-public-tontines"],
          queryFn: () => listPublicTontines(token),
        },
      ] satisfies WarmupEntry<unknown>[];
    }
    return [
      {
        queryKey: ["akwe-dashboard-wallet", user.id],
        queryFn: () => getPrimaryWallet(token, user.id),
      },
      {
        queryKey: ["akwe-dashboard-tontines", user.id],
        queryFn: () => listUserTontines(token),
      },
    ] satisfies WarmupEntry<unknown>[];
  }, [preset, token, user?.id]);

  useSmartWarmup(entries, enabled && entries.length > 0);
}
