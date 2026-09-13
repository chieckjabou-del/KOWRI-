import { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { idempotencyKeysTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createHash } from "crypto";
import { generateId } from "../lib/id";

declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
      idempotencyLockKey?: string;
      saveIdempotentResponse?: (body: unknown) => Promise<void>;
    }
  }
}

const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const PENDING_MARKER = { __pending: true };

interface StoredResponse {
  __status?: number;
  __pending?: boolean;
  body?: unknown;
}

// The key is bound to the request it was first used with. Re-using it with a
// different body is a client bug (or an attempt to smuggle a second operation
// behind a cached success) and is refused rather than silently replayed.
function fingerprint(req: Request): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as any)[k])]));
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canonical(req.body ?? null))).digest("hex");
}

export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction): void {
  const raw = req.headers["idempotency-key"] ?? req.headers["x-idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;

  if (!key || key.trim() === "") {
    res.status(400).json({
      error: true,
      message: "Missing required header: Idempotency-Key. Every financial operation must include a unique idempotency key.",
    });
    return;
  }

  if (key.length > 255) {
    res.status(400).json({
      error: true,
      message: "Idempotency-Key must be 255 characters or fewer.",
    });
    return;
  }

  req.idempotencyKey = key.trim();
  next();
}

// The key is reserved in the database before the handler runs, so two requests
// carrying the same key can never both execute — across retries or instances.
async function reserve(key: string, endpoint: string, requestHash: string): Promise<"reserved" | "in_flight" | "mismatch" | StoredResponse> {
  const inserted = await db.insert(idempotencyKeysTable)
    .values({ id: generateId(), key, endpoint, requestHash, responseBody: PENDING_MARKER as any })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeysTable.id });
  if (inserted.length) return "reserved";

  const [existing] = await db.select().from(idempotencyKeysTable)
    .where(and(eq(idempotencyKeysTable.key, key), eq(idempotencyKeysTable.endpoint, endpoint)))
    .limit(1);
  if (!existing) return reserve(key, endpoint, requestHash);

  const expired = existing.createdAt.getTime() < Date.now() - IDEMPOTENCY_TTL_MS;
  if (expired) {
    await db.delete(idempotencyKeysTable).where(eq(idempotencyKeysTable.id, existing.id));
    return reserve(key, endpoint, requestHash);
  }

  if (existing.requestHash && existing.requestHash !== requestHash) return "mismatch";

  const stored = existing.responseBody as StoredResponse;
  if (stored && typeof stored === "object" && stored.__pending) return "in_flight";
  return stored;
}

export function checkIdempotency(req: Request, res: Response, next: NextFunction): void {
  const key = req.idempotencyKey;
  if (!key) { next(); return; }

  // Scoped per caller so one user's key can never replay another user's cached response.
  const actor    = req.auth?.userId ?? "anonymous";
  const endpoint = `${req.method}:${req.baseUrl}${req.route?.path ?? req.path}|u:${actor}`;

  reserve(key, endpoint, fingerprint(req))
    .then((outcome) => {
      if (outcome === "mismatch") {
        res.status(422).json({
          error: true,
          message: "This Idempotency-Key was already used with a different request body.",
          code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
        });
        return;
      }
      if (outcome === "in_flight") {
        res.status(409).json({
          error: true,
          message: "A request with this Idempotency-Key is currently being processed. Retry after it completes.",
          code: "IDEMPOTENCY_IN_FLIGHT",
        });
        return;
      }

      if (outcome !== "reserved") {
        res.setHeader("X-Idempotent-Replayed", "true");
        res.setHeader("X-Idempotent-Key", key);
        const status = typeof outcome.__status === "number" ? outcome.__status : 200;
        const body = "body" in outcome ? outcome.body : outcome;
        res.status(status).json(body);
        return;
      }

      req.idempotencyLockKey = `${endpoint}::${key}`;

      let capturedBody: unknown = undefined;
      let captured = false;
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        capturedBody = body;
        captured = true;
        return originalJson(body);
      }) as Response["json"];

      req.saveIdempotentResponse = async (body: unknown) => {
        capturedBody = body;
        captured = true;
      };

      res.on("finish", () => {
        const success = res.statusCode >= 200 && res.statusCode < 300;
        const persist = success && captured
          ? db.update(idempotencyKeysTable)
              .set({ responseBody: { __status: res.statusCode, body: capturedBody } as any })
              .where(and(eq(idempotencyKeysTable.key, key), eq(idempotencyKeysTable.endpoint, endpoint)))
          : db.delete(idempotencyKeysTable)
              .where(and(eq(idempotencyKeysTable.key, key), eq(idempotencyKeysTable.endpoint, endpoint)));
        Promise.resolve(persist).catch((err) => console.error("[Idempotency] Failed to finalize key:", err));
      });

      next();
    })
    .catch(next);
}
