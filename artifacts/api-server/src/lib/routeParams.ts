import type { Request } from "express";

/** Normalize a route param to a single string (Express 5 may use string | string[]). */
export function routeParamString(req: Request, name: string): string | undefined {
  const raw = req.params[name];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}
