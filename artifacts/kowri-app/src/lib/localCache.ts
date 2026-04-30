const CACHE_VERSION = 1;

interface CacheEnvelope<T> {
  version: number;
  updatedAt: number;
  data: T;
}

export interface CachedValue<T> {
  data: T;
  updatedAt: number;
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

export function makeCacheKey(scope: string, userId?: string | null): string {
  const suffix = userId ? `:${userId}` : ":anon";
  return `akwe-cache:${scope}${suffix}`;
}

export function readCachedValue<T>(
  key: string,
  maxAgeMs: number,
): CachedValue<T> | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || parsed.version !== CACHE_VERSION) return null;
    if (!Number.isFinite(parsed.updatedAt)) return null;
    if (Date.now() - parsed.updatedAt > maxAgeMs) {
      window.localStorage.removeItem(key);
      return null;
    }
    return { data: parsed.data, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

export function writeCachedValue<T>(key: string, data: T): void {
  if (!canUseStorage()) return;
  try {
    const envelope: CacheEnvelope<T> = {
      version: CACHE_VERSION,
      updatedAt: Date.now(),
      data,
    };
    window.localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // Ignore quota/storage failures to keep UX uninterrupted.
  }
}
