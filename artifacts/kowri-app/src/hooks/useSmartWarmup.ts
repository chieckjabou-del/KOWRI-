import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

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

    const timeoutId = window.setTimeout(run, 1300);
    return () => window.clearTimeout(timeoutId);
  }, [enabled, entries, queryClient]);
}
