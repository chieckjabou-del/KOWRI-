import { Request, Response, NextFunction } from "express";
import { STICKY_MS } from "../lib/dbRouter";

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

/**
 * REQUEST phase — reads incoming sticky-primary headers set by a prior write.
 * Sets req.forcePrimary = true when:
 *   - X-Read-Primary: 1 AND X-Primary-Until is still in the future, OR
 *   - ?fresh=1 query param is present.
 */
export function stickyPrimaryRequest(req: Request, _res: Response, next: NextFunction): void {
  const flag  = req.headers[HEADER_FLAG];
  const until = req.headers[HEADER_UNTIL];
  const fresh = req.query["fresh"] === "1";

  req.forcePrimary = fresh ||
    (flag === "1" && !!until && Date.now() < Number(until));

  next();
}

/**
 * RESPONSE phase — after any mutating request, attach sticky-primary headers
 * so the client can echo them on the next read within the window.
 */
export function stickyPrimaryResponse(req: Request, res: Response, next: NextFunction): void {
  if (!WRITE_METHODS.has(req.method)) { next(); return; }

  const primaryUntil = Date.now() + STICKY_MS;

  const originalJson = res.json.bind(res);
  res.json = function (body: unknown) {
    if (!res.headersSent) {
      res.setHeader(HEADER_FLAG,  "1");
      res.setHeader(HEADER_UNTIL, String(primaryUntil));
    }
    return originalJson(body);
  };

  next();
}
