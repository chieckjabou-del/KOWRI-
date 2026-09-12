import type { Request, Response, NextFunction } from "express";

interface Bucket {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;
const LOCKOUT_MS = 15 * 60_000;

// In-process store: sufficient to stop naive brute force on a single instance.
// Move to a shared store (Redis/DB) before scaling horizontally.
const buckets = new Map<string, Bucket>();

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function bucketKey(req: Request): string {
  const identifier = String(req.body?.phone ?? req.body?.email ?? "").trim().toLowerCase();
  return `${clientIp(req)}|${identifier}`;
}

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = bucketKey(req);
  const now = Date.now();
  const bucket = buckets.get(key);

  if (bucket && bucket.lockedUntil > now) {
    res.setHeader("Retry-After", String(Math.ceil((bucket.lockedUntil - now) / 1000)));
    res.status(429).json({ error: "Too many failed attempts. Try again later." });
    return;
  }

  res.on("finish", () => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      recordFailure(key, now);
    } else if (res.statusCode >= 200 && res.statusCode < 300) {
      buckets.delete(key);
    }
  });

  next();
}

function recordFailure(key: string, now: number): void {
  const existing = buckets.get(key);
  if (!existing || now - existing.firstFailureAt > WINDOW_MS) {
    buckets.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
    return;
  }
  existing.failures += 1;
  if (existing.failures >= MAX_FAILURES) {
    existing.lockedUntil = now + LOCKOUT_MS;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.lockedUntil < now && now - bucket.firstFailureAt > WINDOW_MS) buckets.delete(key);
  }
}, 60_000).unref();
