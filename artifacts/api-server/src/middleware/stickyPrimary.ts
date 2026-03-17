import { Request, Response, NextFunction } from "express";
import { computeStickyWindowMs, recordRequest, recordErrorEvent } from "../lib/windowAdvisor";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const HEADER_FLAG   = "x-read-primary";
const HEADER_UNTIL  = "x-primary-until";

declare global {
  namespace Express {
    interface Request {
      forcePrimary: boolean;
    }
  }
}

// ── Server-side sticky-primary store ─────────────────────────────────────────
// Map<identity, primaryUntil (epoch ms)>
// Identity = userId from body/params, fallback = client IP.
// Pruned lazily on lookup + periodically every 60 s.

const store = new Map<string, number>();

function pruneStore(): void {
  const now = Date.now();
  for (const [k, until] of store) {
    if (now >= until) store.delete(k);
  }
}

setInterval(pruneStore, 60_000).unref();

// windowMs is computed once per response and passed in so the server store
// and the X-Primary-Until client header always use the identical value.
function storeSet(identity: string, windowMs: number): void {
  store.set(identity, Date.now() + windowMs);
}

function storeHas(identity: string): boolean {
  const until = store.get(identity);
  if (until === undefined) return false;
  if (Date.now() >= until) { store.delete(identity); return false; }
  return true;
}

// ── Identity extraction ───────────────────────────────────────────────────────
// Tries userId from body / params / query, then falls back to client IP.
// Same function used on both request and response sides for consistency.

function extractIdentity(req: Request, responseBody?: Record<string, unknown>): string {
  return (
    (responseBody?.userId  as string | undefined) ||
    (responseBody?.id      as string | undefined) ||
    (req.body?.userId      as string | undefined) ||
    (req.params?.userId    as string | undefined) ||
    (req.params?.walletId  as string | undefined) ||
    (req.query?.userId     as string | undefined) ||
    req.ip ||
    "unknown"
  );
}

// ── REQUEST middleware ────────────────────────────────────────────────────────
// Sets req.forcePrimary = true when:
//   1. Server-side store has a live entry for this identity, OR
//   2. Client echoes X-Read-Primary: 1 with a valid X-Primary-Until, OR
//   3. ?fresh=1 is present.

export function stickyPrimaryRequest(req: Request, _res: Response, next: NextFunction): void {
  recordRequest();

  const clientFlag  = req.headers[HEADER_FLAG];
  const clientUntil = req.headers[HEADER_UNTIL];
  const fresh       = req.query["fresh"] === "1";

  const clientSticky = clientFlag === "1" && !!clientUntil && Date.now() < Number(clientUntil);
  const serverSticky = storeHas(extractIdentity(req));

  req.forcePrimary = fresh || clientSticky || serverSticky;

  next();
}

// ── RESPONSE middleware ───────────────────────────────────────────────────────
// After any mutating request:
//   1. Intercepts res.json to inspect the response body for userId/id.
//   2. Writes identity → TTL into server-side store (survives regardless of client).
//   3. Attaches X-Read-Primary / X-Primary-Until headers for cooperative clients.

export function stickyPrimaryResponse(req: Request, res: Response, next: NextFunction): void {
  if (!WRITE_METHODS.has(req.method)) { next(); return; }

  const originalJson = res.json.bind(res);
  res.json = function (body: unknown) {
    const status = res.statusCode ?? 200;

    if (status >= 200 && status < 300) {
      // ── Compute window once so store TTL and client header are identical ─────
      const windowMs     = computeStickyWindowMs();
      const primaryUntil = Date.now() + windowMs;

      const responseBody = (body && typeof body === "object") ? body as Record<string, unknown> : undefined;
      const identity     = extractIdentity(req, responseBody);
      storeSet(identity, windowMs);

      if (!res.headersSent) {
        res.setHeader(HEADER_FLAG,  "1");
        res.setHeader(HEADER_UNTIL, String(primaryUntil));
      }
    } else if (status >= 500) {
      // ── Feed error rate tracker so window advisor rules 4+5 can activate ────
      recordErrorEvent();
    }

    return originalJson(body);
  };

  next();
}

// ── Diagnostics ───────────────────────────────────────────────────────────────
export function getStickyStoreStats() {
  pruneStore();
  return { activeEntries: store.size, stickyWindowMs: computeStickyWindowMs() };
}
