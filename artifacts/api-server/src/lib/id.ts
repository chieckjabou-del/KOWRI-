import { randomUUID } from "crypto";

/** Optional prefix for human-readable IDs (e.g. `usr`, `wal`); UUID remains unique. */
export function generateId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function generateReference(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `KWR-${ts}-${rand}`;
}

export function generateApiKey(): string {
  return `kwk_${randomUUID().replace(/-/g, "")}`;
}
