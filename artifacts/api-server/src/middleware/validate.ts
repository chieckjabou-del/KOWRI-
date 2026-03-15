import { Request, Response, NextFunction } from "express";

const VALID_CURRENCIES = new Set(["XOF", "XAF"]);
const VALID_WALLET_STATUSES = new Set(["active", "suspended", "frozen"]);
const VALID_TX_STATUSES = new Set(["pending", "completed", "failed", "reversed"]);
const VALID_KYC_STATUSES = new Set(["pending", "verified", "rejected", "expired"]);
const VALID_LOAN_STATUSES = new Set(["pending", "approved", "disbursed", "repaid", "defaulted"]);
const VALID_USER_STATUSES = new Set(["active", "suspended", "pending_kyc"]);

const XSS_PATTERN = /<[^>]*>|javascript:|on\w+\s*=/i;
const SQLI_PATTERN = /('|--|;|\/\*|\*\/|xp_|UNION\s+SELECT|DROP\s+TABLE|INSERT\s+INTO|DELETE\s+FROM)/i;

function isMalicious(value: string): boolean {
  return XSS_PATTERN.test(value) || SQLI_PATTERN.test(value);
}

function sanitizeParams(params: Record<string, unknown>): string | null {
  for (const [, val] of Object.entries(params)) {
    if (typeof val === "string" && isMalicious(val)) {
      return `Potentially malicious input detected`;
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

export { VALID_CURRENCIES, VALID_WALLET_STATUSES, VALID_TX_STATUSES, VALID_KYC_STATUSES, VALID_LOAN_STATUSES, VALID_USER_STATUSES };
