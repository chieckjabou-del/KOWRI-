import { useRef } from "react";

export function useIdempotency() {
  const keyRef = useRef<string | null>(null);

  function getKey(): string {
    if (!keyRef.current) {
      keyRef.current = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    }
    return keyRef.current;
  }

  function resetKey() {
    keyRef.current = null;
  }

  return { getKey, resetKey };
}
