import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { db } from "@workspace/db";
import { idempotencyKeysTable } from "@workspace/db";
import { eq } from "drizzle-orm";

declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
      idempotencyLockKey?: string;
      idempotencyRecordId?: string;
      saveIdempotentResponse?: (body: unknown, statusCode?: number) => Promise<void>;
    }
  }
}

const inFlight = new Map<string, Promise<void>>();

type StoredIdempotencyEnvelope = {
  __idempotencyEnvelope: 1;
  statusCode: number;
  payload: unknown;
};

function buildRecordId(endpoint: string, key: string): string {
  const hash = createHash("sha256").update(`${endpoint}::${key}`).digest("hex");
  return `idem_${hash}`;
}

function isPendingPayload(payload: unknown): boolean {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "__idempotencyPending" in (payload as Record<string, unknown>) &&
      (payload as Record<string, unknown>)["__idempotencyPending"] === true
  );
}

function unpackStoredPayload(
  payload: unknown
): { statusCode: number; payload: unknown } {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (record["__idempotencyEnvelope"] !== 1) {
      return { statusCode: 200, payload };
    }
    const envelope = record as unknown as StoredIdempotencyEnvelope;
    return {
      statusCode: typeof envelope.statusCode === "number" ? envelope.statusCode : 200,
      payload: envelope.payload,
    };
  }
  return { statusCode: 200, payload };
}

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
  const recordId = buildRecordId(endpoint, key);
  req.idempotencyRecordId = recordId;

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

  (async () => {
    const existingRows = await db.select()
      .from(idempotencyKeysTable)
      .where(eq(idempotencyKeysTable.id, recordId))
      .limit(1);
    const existing = existingRows[0];

    if (existing) {
      releaseLock();
      inFlight.delete(lockKey);

      if (isPendingPayload(existing.responseBody)) {
        res.status(409).json({
          error: true,
          message: "A request with this Idempotency-Key is currently being processed. Retry after it completes.",
          code: "IDEMPOTENCY_IN_FLIGHT",
        });
        return;
      }

      const replay = unpackStoredPayload(existing.responseBody);
      res.setHeader("X-Idempotent-Replayed", "true");
      res.setHeader("X-Idempotent-Key", key);
      res.status(replay.statusCode).json(replay.payload);
      return;
    }

    const reserved = await db.insert(idempotencyKeysTable).values({
      id: recordId,
      key,
      endpoint,
      responseBody: { __idempotencyPending: true } as any,
    }).onConflictDoNothing().returning({ id: idempotencyKeysTable.id });

    if (!reserved.length) {
      const raceRows = await db.select()
        .from(idempotencyKeysTable)
        .where(eq(idempotencyKeysTable.id, recordId))
        .limit(1);
      const raceWinner = raceRows[0];
      releaseLock();
      inFlight.delete(lockKey);

      if (raceWinner && !isPendingPayload(raceWinner.responseBody)) {
        const replay = unpackStoredPayload(raceWinner.responseBody);
        res.setHeader("X-Idempotent-Replayed", "true");
        res.setHeader("X-Idempotent-Key", key);
        res.status(replay.statusCode).json(replay.payload);
        return;
      }

      res.status(409).json({
        error: true,
        message: "A request with this Idempotency-Key is currently being processed. Retry after it completes.",
        code: "IDEMPOTENCY_IN_FLIGHT",
      });
      return;
    }

    let responseStored = false;
    req.idempotencyLockKey = lockKey;
    req.saveIdempotentResponse = async (body: unknown, statusCode = 200) => {
      try {
        await db.update(idempotencyKeysTable)
          .set({
            responseBody: {
              __idempotencyEnvelope: 1,
              statusCode,
              payload: body,
            } as StoredIdempotencyEnvelope,
          })
          .where(eq(idempotencyKeysTable.id, recordId));
        responseStored = true;
      } catch (err: unknown) {
        console.error("[Idempotency] Failed to store response:", err);
      } finally {
        releaseLock();
        inFlight.delete(lockKey);
      }
    };

    res.on("finish", () => {
      if (!responseStored) {
        db.delete(idempotencyKeysTable)
          .where(eq(idempotencyKeysTable.id, recordId))
          .catch((err: unknown) => console.error("[Idempotency] Failed to cleanup reservation:", err));
      }
      if (inFlight.has(lockKey)) {
        releaseLock();
        inFlight.delete(lockKey);
      }
    });

    next();
  })().catch((err: unknown) => {
    releaseLock();
    inFlight.delete(lockKey);
    next(err);
  });
}
