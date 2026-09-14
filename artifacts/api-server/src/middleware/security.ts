// ── HTTP hardening ───────────────────────────────────────────────────────────
// The API serves the compiled front-ends from the same origin, so browsers never
// need cross-origin access in the normal topology. CORS is therefore closed by
// default in production and opened only for the origins listed in CORS_ORIGINS
// (a Vercel preview that talks to a remote API, a partner console, …).
// Outside production every origin is accepted so local front-ends on another
// port keep working.

import type { Request, Response, NextFunction } from "express";
import type { CorsOptions } from "cors";

export function allowedOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function corsOptions(): CorsOptions {
  const allowlist = new Set(allowedOrigins());
  const permissive = allowlist.size === 0 && process.env.NODE_ENV !== "production";
  return {
    origin(origin, callback) {
      // Same-origin and non-browser clients (mobile app, curl, server-to-server) send no Origin.
      if (!origin) { callback(null, true); return; }
      if (permissive || allowlist.has(origin.replace(/\/+$/, ""))) { callback(null, true); return; }
      // Not allowed: answer without CORS headers, the browser blocks the read.
      callback(null, false);
    },
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Admin-Token", "X-Admin-Key", "X-Request-Id"],
    exposedHeaders: ["X-Idempotent-Replayed", "X-Request-Id"],
    maxAge: 600,
  };
}

// Conservative response headers. No Content-Security-Policy yet: the bundled
// front-ends rely on inline styles/scripts that a strict policy would break;
// adding one is tracked separately.
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=(self), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
}
