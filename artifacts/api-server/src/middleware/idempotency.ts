import { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { idempotencyKeysTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
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

const inFlight = new Map<string, Promise<void>>();

export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["idempotency-key"] as string | undefined;

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

export function checkIdempotency(req: Request, res: Response, next: NextFunction): void {
  const key = req.idempotencyKey;
  if (!key) { next(); return; }

  const endpoint = `${req.method}:${req.route?.path ?? req.path}`;
  const lockKey  = `${endpoint}::${key}`;

  if (inFlight.has(lockKey)) {
    res.status(409).json({
      error: true,
      message: "A request with this Idempotency-Key is currently being processed. Retry after it completes.",
      code: "IDEMPOTENCY_IN_FLIGHT",
    });
    return;
  }

  let releaseLock!: () => void;
  const lockPromise = new Promise<void>(resolve => { releaseLock = resolve; });
  inFlight.set(lockKey, lockPromise);

  db.select()
    .from(idempotencyKeysTable)
    .where(and(eq(idempotencyKeysTable.key, key), eq(idempotencyKeysTable.endpoint, endpoint)))
    .limit(1)
    .then(([existing]) => {
      if (existing) {
        releaseLock();
        inFlight.delete(lockKey);
        res.setHeader("X-Idempotent-Replayed", "true");
        res.setHeader("X-Idempotent-Key", key);
        res.status(200).json(existing.responseBody);
        return;
      }

      req.idempotencyLockKey = lockKey;
      req.saveIdempotentResponse = async (body: unknown) => {
        try {
          await db.insert(idempotencyKeysTable).values({
            id: generateId(),
            key,
            endpoint,
            responseBody: body as any,
          }).onConflictDoNothing();
        } catch (err) {
          console.error("[Idempotency] Failed to store response:", err);
        } finally {
          releaseLock();
          inFlight.delete(lockKey);
        }
      };

      res.on("finish", () => {
        if (inFlight.has(lockKey)) {
          releaseLock();
          inFlight.delete(lockKey);
        }
      });

      next();
    })
    .catch(err => {
      releaseLock();
      inFlight.delete(lockKey);
      next(err);
    });
}
