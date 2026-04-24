import { Request, Response, NextFunction } from "express";

const VALID_CURRENCIES       = new Set(["XOF", "XAF"]);
const VALID_WALLET_STATUSES  = new Set(["active", "suspended", "frozen"]);
const VALID_TX_STATUSES      = new Set(["pending", "processing", "completed", "failed", "reversed"]);
const VALID_KYC_STATUSES     = new Set(["pending", "verified", "rejected", "expired"]);
const VALID_LOAN_STATUSES    = new Set(["pending", "approved", "disbursed", "repaid", "defaulted"]);
const VALID_USER_STATUSES    = new Set(["active", "suspended", "pending_kyc"]);

const XSS_PATTERN  = /<[^>]*>|javascript:|on\w+\s*=/i;
const SQLI_PATTERN = /('|--|;|\/\*|\*\/|xp_|UNION\s+SELECT|DROP\s+TABLE|INSERT\s+INTO|DELETE\s+FROM)/i;
const PHONE_PATTERN = /^\+?\d{8,15}$/;
const PIN_PATTERN = /^\d{4}$/;

function isMalicious(value: string): boolean {
  return XSS_PATTERN.test(value) || SQLI_PATTERN.test(value);
}

function sanitizeParams(params: Record<string, unknown>): string | null {
  for (const [, val] of Object.entries(params)) {
    if (typeof val === "string" && isMalicious(val)) {
      return "Potentially malicious input detected";
    }
  }
  return null;
}

export function validatePagination(req: Request, res: Response, next: NextFunction): void {
  const { limit, page } = req.query;

  if (limit !== undefined) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      res.status(400).json({ error: true, message: "Invalid request parameters: limit must be between 1 and 100" });
      return;
    }
  }

  if (page !== undefined) {
    const n = Number(page);
    if (!Number.isFinite(n) || n < 1 || n > 1000) {
      res.status(400).json({ error: true, message: "Invalid request parameters: page must be between 1 and 1000" });
      return;
    }
  }

  next();
}

export function validateQueryParams(allowedEnums: Record<string, Set<string>> = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const malicious = sanitizeParams({ ...req.query, ...req.params, ...req.body });
    if (malicious) {
      res.status(400).json({ error: true, message: "Invalid request parameters: " + malicious });
      return;
    }

    for (const [param, allowed] of Object.entries(allowedEnums)) {
      const val = req.query[param];
      if (val !== undefined && typeof val === "string" && val !== "" && !allowed.has(val)) {
        res.status(400).json({
          error: true,
          message: `Invalid request parameters: '${param}' must be one of [${[...allowed].join(", ")}]`,
        });
        return;
      }
    }

    next();
  };
}

export const globalSanitizer = (req: Request, res: Response, next: NextFunction): void => {
  const malicious = sanitizeParams({ ...req.query, ...req.params });
  if (malicious) {
    res.status(400).json({ error: true, message: "Invalid request parameters: " + malicious });
    return;
  }
  next();
};

export function normalizePhone(value: unknown): string | null {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[\s\-()]/g, "");

  if (!PHONE_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

export function parsePin(value: unknown): string | null {
  const pin = String(value ?? "").trim();
  return PIN_PATTERN.test(pin) ? pin : null;
}

export function parsePositiveAmount(value: unknown): number | null {
  const amount =
    typeof value === "number"
      ? value
      : Number(String(value ?? "").trim());

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return amount;
}

export function parsePositiveInteger(
  value: unknown,
  options: { min?: number; max?: number } = {}
): number | null {
  const { min = 1, max = 100_000 } = options;
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value ?? "").trim());

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }

  return parsed;
}

export {
  VALID_CURRENCIES, VALID_WALLET_STATUSES, VALID_TX_STATUSES,
  VALID_KYC_STATUSES, VALID_LOAN_STATUSES, VALID_USER_STATUSES,
};
