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
    error: "Not found",
    method: req.method,
    path: req.path,
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof KillSwitchError) {
    res.status(503).json({
      error:   true,
      code:    "OPERATION_SUSPENDED",
      switch:  err.switchName,
      state:   err.state,
      reason:  err.reason,
      message: `Service temporarily unavailable — ${err.switchName} is ${err.state}`,
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: true, message: err.message });
    return;
  }

  const isDev = process.env.NODE_ENV === "development";

  if (err instanceof Error) {
    const msg = err.message;

    if (msg.includes("not found") || msg.includes("No results")) {
      res.status(404).json({ error: true, message: msg });
      return;
    }

    if (msg.includes("invalid input") || msg.includes("violates") || msg.includes("invalid_text_representation")) {
      res.status(400).json({ error: true, message: "Invalid request parameters" });
      return;
    }

    console.error("[ERROR]", msg, isDev ? err.stack : "");
    res.status(500).json({ error: true, message: "An unexpected error occurred" });
    return;
  }

  console.error("[ERROR] Unknown error:", err);
  res.status(500).json({ error: true, message: "An unexpected error occurred" });
}
