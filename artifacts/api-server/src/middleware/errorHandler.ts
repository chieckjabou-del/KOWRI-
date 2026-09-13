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
  res.status(404).json({ error: true, message: `Route ${req.method} ${req.path} not found` });
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

    // Ledger-level refusals are client errors, never 500s.
    if (err.name === "TransactionBlockedError") {
      const findings = ((err as any).findings ?? []) as Array<{ type: string; blocking: boolean }>;
      res.status(403).json({
        error: true,
        code: "TRANSACTION_BLOCKED",
        message: "Cette opération a été bloquée par le contrôle de risque.",
        reasons: findings.filter((f) => f.blocking).map((f) => f.type),
      });
      return;
    }
    if (err.name === "KycLimitError") {
      res.status(400).json({ error: true, code: "KYC_LIMIT", message: msg });
      return;
    }
    if (err.name === "WalletUnavailableError" || err.name === "CurrencyMismatchError" || err.name === "InvalidAmountError" || err.name === "InvalidFeeError") {
      res.status(400).json({ error: true, code: err.name, message: msg });
      return;
    }
    if (err.name === "FxArbitrageError" || err.name === "FXNotFoundError") {
      res.status(409).json({ error: true, code: err.name === "FxArbitrageError" ? "FX_ARBITRAGE" : "FX_RATE_MISSING", message: msg });
      return;
    }
    // A financial operation whose idempotency key already exists in the ledger
    // has been applied once: the retry is refused instead of re-executed, and
    // the client reconciles through GET /transactions.
    const pg = err as { code?: string; constraint?: string };
    if (pg.code === "23505" && (pg.constraint?.includes("idempotency") || msg.includes("idempotency"))) {
      res.status(409).json({ error: true, code: "ALREADY_PROCESSED", message: "This operation was already applied; do not retry with the same idempotency key" });
      return;
    }
    if (msg === "Insufficient funds") {
      res.status(400).json({ error: true, code: "INSUFFICIENT_FUNDS", message: msg });
      return;
    }
    if (err.name === "RateLimitExceededError") {
      res.status(429).json({ error: true, code: "RATE_LIMITED", message: msg, retryAfter: 60 });
      return;
    }

    // Entity lookups ("Loan not found", "Agent wallet not found") are 404s; any
    // longer message that merely contains the words is an internal error.
    if (/^[\w' -]{1,60} not found$/i.test(msg) || msg === "No results") {
      res.status(404).json({ error: true, message: msg });
      return;
    }

    // Oversized or malformed bodies rejected by the body parser.
    const status = (err as any).status ?? (err as any).statusCode;
    if (err.name === "PayloadTooLargeError" || status === 413) {
      res.status(413).json({ error: true, code: "PAYLOAD_TOO_LARGE", message: "Request body too large" });
      return;
    }
    if (err.name === "SyntaxError" && status === 400) {
      res.status(400).json({ error: true, code: "MALFORMED_JSON", message: "Malformed JSON body" });
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
