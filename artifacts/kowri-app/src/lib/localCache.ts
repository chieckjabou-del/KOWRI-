const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface CacheEnvelope<T> {
  version: number;
  updatedAt: number;
  data: T;
}

export interface CachedValue<T> {
  data: T;
  updatedAt: number;
}

type WriteCacheOptions = {
  ttlMs?: number;
};

function canUseStorage(): boolean {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function now(): number {
  return Date.now();
}

export function makeCacheKey(scope: string, userId?: string | null): string {
  const suffix = userId ? `:${userId}` : ":anon";
  return `akwe-cache:${scope}${suffix}`;
}

function readEnvelope<T>(key: string): CacheEnvelope<T> | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || parsed.version !== CACHE_VERSION) return null;
    if (!Number.isFinite(parsed.updatedAt)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeEnvelope<T>(key: string, data: T): void {
  if (!canUseStorage()) return;
  try {
    const envelope: CacheEnvelope<T> = {
      version: CACHE_VERSION,
      updatedAt: now(),
      data,
    };
    window.localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // Ignore quota/storage failures to keep UX uninterrupted.
  }
}

export function readCachedValue<T>(key: string, maxAgeMs: number): CachedValue<T> | null {
  const envelope = readEnvelope<T>(key);
  if (!envelope) return null;
  if (now() - envelope.updatedAt > maxAgeMs) {
    if (canUseStorage()) {
      window.localStorage.removeItem(key);
    }
    return null;
  }
  return { data: envelope.data, updatedAt: envelope.updatedAt };
}

export function writeCachedValue<T>(key: string, data: T): void {
  writeEnvelope(key, data);
}

// Compatibility aliases used across pages.
export function readCache<T>(key: string, ttlMs = DEFAULT_TTL_MS): T | null {
  return readCachedValue<T>(key, ttlMs)?.data ?? null;
}

export function writeCache<T>(
  key: string,
  data: T,
  ttlOrOptions?: number | WriteCacheOptions,
): void {
  // We persist the value and enforce TTL during reads.
  // ttlOrOptions is accepted for API compatibility with callers.
  void ttlOrOptions;
  writeEnvelope(key, data);
}

export function getCached<T>(key: string, ttlMs = DEFAULT_TTL_MS): T | null {
  return readCache<T>(key, ttlMs);
}

export function setCached<T>(key: string, data: T, ttlMs?: number): void {
  writeCache(key, data, ttlMs);
}

export function getCachedOrDefault<T>(key: string, defaultValue: T, ttlMs = DEFAULT_TTL_MS): T {
  return readCache<T>(key, ttlMs) ?? defaultValue;
}

export function setCachedValue<T>(key: string, data: T, ttlMs?: number): void {
  writeCache(key, data, ttlMs);
}
