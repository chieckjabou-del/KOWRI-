import { Request, Response, NextFunction } from "express";
import { KillSwitchError } from "../lib/killSwitch";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: true,
    code: "ROUTE_NOT_FOUND",
    message: `Route ${req.method} ${req.originalUrl} not found`,
    requestId: req.requestId ?? null,
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.requestId ?? null;

  if (err instanceof KillSwitchError) {
    console.error("[ERROR]", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      type: "KillSwitchError",
      switchName: err.switchName,
      state: err.state,
      reason: err.reason,
    });
    res.status(503).json({
      error:   true,
      code:    "OPERATION_SUSPENDED",
      switch:  err.switchName,
      state:   err.state,
      reason:  err.reason,
      message: `Service temporarily unavailable — ${err.switchName} is ${err.state}`,
      requestId,
    });
    return;
  }

  if (err instanceof AppError) {
    console.error("[ERROR]", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      type: "AppError",
      statusCode: err.statusCode,
      message: err.message,
    });
    res.status(err.statusCode).json({
      error: true,
      code: "APP_ERROR",
      message: err.message,
      requestId,
    });
    return;
  }

  const isDev = process.env.NODE_ENV === "development";

  if (err instanceof Error) {
    const msg = err.message;

    if (msg.includes("not found") || msg.includes("No results")) {
      console.error("[ERROR]", {
        requestId,
        method: req.method,
        path: req.originalUrl,
        type: "NotFoundError",
        message: msg,
      });
      res.status(404).json({ error: true, code: "NOT_FOUND", message: msg, requestId });
      return;
    }

    if (msg.includes("invalid input") || msg.includes("violates") || msg.includes("invalid_text_representation")) {
      console.error("[ERROR]", {
        requestId,
        method: req.method,
        path: req.originalUrl,
        type: "ValidationError",
        message: msg,
      });
      res.status(400).json({
        error: true,
        code: "INVALID_REQUEST_PARAMETERS",
        message: "Invalid request parameters",
        requestId,
      });
      return;
    }

    console.error("[ERROR]", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      type: "UnexpectedError",
      message: msg,
      stack: isDev ? err.stack : undefined,
    });
    res.status(500).json({
      error: true,
      code: "UNEXPECTED_ERROR",
      message: "An unexpected error occurred",
      requestId,
    });
    return;
  }

  console.error("[ERROR]", {
    requestId,
    method: req.method,
    path: req.originalUrl,
    type: "UnknownError",
    error: err,
  });
  res.status(500).json({
    error: true,
    code: "UNEXPECTED_ERROR",
    message: "An unexpected error occurred",
    requestId,
  });
}
