import type { NextFunction, Request, Response } from "express";

type BucketState = {
  count: number;
  resetAt: number;
};

const WINDOW_MS = 60_000;
const GLOBAL_LIMIT = 120;
const AUTH_LIMIT = 20;
const buckets = new Map<string, BucketState>();

function getClientIp(req: Request): string {
  const xf = req.headers["x-forwarded-for"];
  const first = Array.isArray(xf) ? xf[0] : String(xf ?? "");
  if (first) return first.split(",")[0]?.trim() ?? req.ip ?? "unknown";
  return req.ip ?? "unknown";
}

function isAuthPath(path: string): boolean {
  return (
    path.includes("/auth/login") ||
    path.includes("/users/login") ||
    path.includes("/wallet/login") ||
    path.includes("/merchant/login") ||
    path.includes("/developer/login") ||
    path.includes("/users")
  );
}

function getLimitForPath(path: string): number {
  return isAuthPath(path) ? AUTH_LIMIT : GLOBAL_LIMIT;
}

export function apiRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req);
  const path = req.originalUrl || req.path || "";
  const limit = getLimitForPath(path);
  const key = `${ip}:${isAuthPath(path) ? "auth" : "global"}`;
  const now = Date.now();

  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  if (current.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: true,
      message: "Too many requests. Please retry later.",
      retryAfter: retryAfterSeconds,
    });
    return;
  }

  current.count += 1;
  buckets.set(key, current);
  next();
}
