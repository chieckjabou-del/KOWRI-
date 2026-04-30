import { useCallback, useRef } from "react";

export function useActionCooldown(cooldownMs = 900) {
  const lastActionAt = useRef<Record<string, number>>({});

  const canRun = useCallback(
    (key: string): boolean => {
      const now = Date.now();
      const last = lastActionAt.current[key] ?? 0;
      if (now - last < cooldownMs) return false;
      lastActionAt.current[key] = now;
      return true;
    },
    [cooldownMs],
  );

  return { canRun };
}
