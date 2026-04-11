import type { NextFunction, Request, Response } from "express";

interface BucketState {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;
const GLOBAL_LIMIT = 180;
const AUTH_LIMIT = 30;
const buckets = new Map<string, BucketState>();

function getClientIp(req: Request): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0]?.trim() ?? "unknown";
  }
  if (Array.isArray(forwardedFor) && forwardedFor[0]) {
    return forwardedFor[0];
  }
  return req.ip || "unknown";
}

function isAuthPath(path: string): boolean {
  return (
    path.startsWith("/auth/") ||
    path === "/auth" ||
    path === "/users/login" ||
    path === "/wallet/login"
  );
}

function getLimitForPath(path: string): number {
  return isAuthPath(path) ? AUTH_LIMIT : GLOBAL_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, state] of buckets.entries()) {
    if (state.resetAt <= now) buckets.delete(key);
  }
}, WINDOW_MS).unref();

export function apiRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health" || req.path === "/healthz") {
    next();
    return;
  }

  const now = Date.now();
  const bucketKey = `${getClientIp(req)}:${isAuthPath(req.path) ? "auth" : "global"}`;
  const limit = getLimitForPath(req.path);
  const current = buckets.get(bucketKey);

  if (!current || current.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  current.count += 1;
  if (current.count > limit) {
    const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: true,
      message: "Too many requests. Please retry later.",
      retryAfter: retryAfterSec,
    });
    return;
  }

  next();
}
