const CACHE_VERSION = 2;
const INDEX_KEY = "akwe-cache:index:v2";
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 90;

export type CacheScope =
  | "wallet"
  | "wallet-transactions"
  | "dashboard"
  | "tontines"
  | "creator"
  | "generic";

interface CacheEnvelope<T> {
  version: number;
  updatedAt: number;
  expiresAt: number;
  scope: CacheScope;
  hash: string;
  data: T;
}

interface CacheIndexEntry {
  key: string;
  updatedAt: number;
  expiresAt: number;
  scope: CacheScope;
}

interface CacheIndex {
  version: number;
  entries: CacheIndexEntry[];
}

export interface CachedValue<T> {
  data: T;
  updatedAt: number;
}

type WriteCacheOptions = {
  ttlMs?: number;
  scope?: CacheScope;
};

function canUseStorage(): boolean {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function now(): number {
  return Date.now();
}

function stableJson(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function readIndex(): CacheIndex {
  if (!canUseStorage()) return { version: CACHE_VERSION, entries: [] };
  try {
    const raw = window.localStorage.getItem(INDEX_KEY);
    if (!raw) return { version: CACHE_VERSION, entries: [] };
    const parsed = JSON.parse(raw) as CacheIndex;
    if (!parsed || parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
      return { version: CACHE_VERSION, entries: [] };
    }
    return parsed;
  } catch {
    return { version: CACHE_VERSION, entries: [] };
  }
}

function writeIndex(index: CacheIndex): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // ignore storage failures
  }
}

function removeKeyFromStorage(key: string): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore storage failures
  }
}

function cleanupIndex(index: CacheIndex): CacheIndex {
  const nowMs = now();
  const alive = index.entries.filter((entry) => entry.expiresAt > nowMs);
  if (alive.length <= MAX_CACHE_ENTRIES) {
    return { ...index, entries: alive };
  }
  const sorted = [...alive].sort((a, b) => b.updatedAt - a.updatedAt);
  const keep = sorted.slice(0, MAX_CACHE_ENTRIES);
  const keepSet = new Set(keep.map((entry) => entry.key));
  for (const entry of alive) {
    if (!keepSet.has(entry.key)) {
      removeKeyFromStorage(entry.key);
    }
  }
  return { ...index, entries: keep };
}

function upsertIndexEntry(key: string, scope: CacheScope, updatedAt: number, expiresAt: number): void {
  const index = readIndex();
  const withoutKey = index.entries.filter((entry) => entry.key !== key);
  const next = cleanupIndex({
    version: CACHE_VERSION,
    entries: [...withoutKey, { key, scope, updatedAt, expiresAt }],
  });
  writeIndex(next);
}

function deleteIndexEntry(key: string): void {
  const index = readIndex();
  const nextEntries = index.entries.filter((entry) => entry.key !== key);
  if (nextEntries.length === index.entries.length) return;
  writeIndex({ version: CACHE_VERSION, entries: nextEntries });
}

function purgeVersionMismatch(): void {
  if (!canUseStorage()) return;
  try {
    const keys = Object.keys(window.localStorage);
    for (const key of keys) {
      if (!key.startsWith("akwe-cache:")) continue;
      if (key === INDEX_KEY) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { version?: number };
        if (parsed.version !== CACHE_VERSION) {
          window.localStorage.removeItem(key);
        }
      } catch {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // ignore storage errors
  }
}

export function makeCacheKey(scope: string, userId?: string | null): string {
  const suffix = userId ? `:${userId}` : ":anon";
  return `akwe-cache:${scope}${suffix}`;
}

function resolveScopeFromKey(key: string): CacheScope {
  if (key.includes("wallet:tx") || key.includes("wallet-transactions")) return "wallet-transactions";
  if (key.includes("wallet")) return "wallet";
  if (key.includes("dashboard")) return "dashboard";
  if (key.includes("tontine")) return "tontines";
  if (key.includes("creator")) return "creator";
  return "generic";
}

function resolveDefaultTTL(scope: CacheScope): number {
  switch (scope) {
    case "wallet":
    case "wallet-transactions":
      return 90_000;
    case "dashboard":
      return 4 * 60_000;
    case "creator":
      return 4 * 60_000;
    case "tontines":
      return 3 * 60_000;
    default:
      return DEFAULT_TTL_MS;
  }
}

function readEnvelope<T>(key: string): CacheEnvelope<T> | null {
  if (!canUseStorage()) return null;
  purgeVersionMismatch();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || parsed.version !== CACHE_VERSION) return null;
    if (!Number.isFinite(parsed.updatedAt) || !Number.isFinite(parsed.expiresAt)) return null;
    if (parsed.expiresAt <= now()) {
      window.localStorage.removeItem(key);
      deleteIndexEntry(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeEnvelope<T>(key: string, data: T, options?: WriteCacheOptions): void {
  if (!canUseStorage()) return;
  const scope = options?.scope ?? resolveScopeFromKey(key);
  const ttlMs = options?.ttlMs ?? resolveDefaultTTL(scope);
  const updatedAt = now();
  const envelope: CacheEnvelope<T> = {
    version: CACHE_VERSION,
    updatedAt,
    expiresAt: updatedAt + ttlMs,
    scope,
    hash: hashString(stableJson(data)),
    data,
  };
  try {
    window.localStorage.setItem(key, JSON.stringify(envelope));
    upsertIndexEntry(key, scope, updatedAt, envelope.expiresAt);
  } catch {
    // Attempt LRU cleanup and retry once.
    try {
      const index = cleanupIndex(readIndex());
      writeIndex(index);
      window.localStorage.setItem(key, JSON.stringify(envelope));
      upsertIndexEntry(key, scope, updatedAt, envelope.expiresAt);
    } catch {
      // ignore irrecoverable storage failures
    }
  }
}

export function readCachedValue<T>(key: string, maxAgeMs: number): CachedValue<T> | null {
  const envelope = readEnvelope<T>(key);
  if (!envelope) return null;
  if (now() - envelope.updatedAt > maxAgeMs) {
    removeKeyFromStorage(key);
    deleteIndexEntry(key);
    return null;
  }
  return { data: envelope.data, updatedAt: envelope.updatedAt };
}

export function writeCachedValue<T>(key: string, data: T): void {
  writeEnvelope(key, data);
}

export function readCache<T>(key: string, ttlMs = DEFAULT_TTL_MS): T | null {
  return readCachedValue<T>(key, ttlMs)?.data ?? null;
}

export function writeCache<T>(
  key: string,
  data: T,
  ttlOrOptions?: number | WriteCacheOptions,
): void {
  if (typeof ttlOrOptions === "number") {
    writeEnvelope(key, data, { ttlMs: ttlOrOptions });
    return;
  }
  writeEnvelope(key, data, ttlOrOptions);
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

export function invalidateCache(key: string): void {
  removeKeyFromStorage(key);
  deleteIndexEntry(key);
}

export function invalidateCacheByScope(scope: CacheScope): void {
  const index = readIndex();
  const keep: CacheIndexEntry[] = [];
  for (const entry of index.entries) {
    if (entry.scope === scope) {
      removeKeyFromStorage(entry.key);
    } else {
      keep.push(entry);
    }
  }
  writeIndex({ version: CACHE_VERSION, entries: keep });
}

export function clearAllCache(): void {
  if (!canUseStorage()) return;
  try {
    const keys = Object.keys(window.localStorage).filter((key) => key.startsWith("akwe-cache:"));
    for (const key of keys) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore storage failures
  }
}

export function hasMajorDataDrift<T>(
  key: string,
  incoming: T,
  threshold = 0.4,
): boolean {
  const envelope = readEnvelope<T>(key);
  if (!envelope) return false;
  const currentSerialized = stableJson(envelope.data);
  const incomingSerialized = stableJson(incoming);
  if (!currentSerialized || !incomingSerialized) return false;
  if (currentSerialized === incomingSerialized) return false;
  const delta = Math.abs(currentSerialized.length - incomingSerialized.length);
  const baseline = Math.max(currentSerialized.length, incomingSerialized.length, 1);
  return delta / baseline > threshold;
}
