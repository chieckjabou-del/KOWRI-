import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

function nowMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.headers["x-request-id"]?.toString().trim() || randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(nowMs(startedAt).toFixed(2));
    const log = {
      type: "http_access",
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs,
      ip: req.ip,
      userAgent: req.get("user-agent") ?? "",
    };
    console.log(JSON.stringify(log));
  });

  next();
}
