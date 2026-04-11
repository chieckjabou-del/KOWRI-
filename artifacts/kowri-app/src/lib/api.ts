import { isDemoToken, mockApiFetch, MockApiError } from "@/lib/mockApi";

const API_BASE = "/api";
const USE_REAL_API = (import.meta.env.VITE_USE_REAL_API ?? "true") === "true";
const USE_API_LOGS = (import.meta.env.VITE_API_LOGS ?? "true") === "true";
const HYBRID_REAL_FIRST_ENDPOINTS = [
  /^\/users\/login$/,
  /^\/users$/,
  /^\/users\/me$/,
  /^\/users\/[^/]+$/,
  /^\/users\/[^/]+\/avatar$/,
  /^\/users\/[^/]+\/kyc$/,
  /^\/users\/[^/]+\/pin$/,
  /^\/wallets(?:\/[^/]+)?$/,
  /^\/transactions(?:\/transfer)?$/,
];

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

let _unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(cb: () => void): void {
  _unauthorizedHandler = cb;
}

function shouldUseHybridRealFirst(path: string): boolean {
  return HYBRID_REAL_FIRST_ENDPOINTS.some((re) => re.test(path));
}

function isRecoverableNetworkError(status: number): boolean {
  return status === 0 || status === 404 || status === 405 || status >= 500;
}

function logRealOk(path: string): void {
  if (USE_API_LOGS) console.log("REAL API OK", path);
}

function logFallback(path: string, reason: string): void {
  if (USE_API_LOGS) console.error("FALLBACK USED", path, reason);
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const j = await res.json();
      return j.message || j.error || fallback;
    } catch {
      return fallback;
    }
  }

  try {
    const text = await res.text();
    if (text.includes("<!DOCTYPE") || text.includes("<html")) {
      return "Service temporairement indisponible. Réessayez dans un instant.";
    }
    return text?.trim() || fallback;
  } catch {
    return fallback;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  token: string | null,
  options: RequestInit = {}
): Promise<T> {
  const isDemoSession = isDemoToken(token);
  const canUseDemoFallback = isDemoSession;
  const canTryRealFirst = USE_REAL_API && shouldUseHybridRealFirst(path);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  async function runMockFallback(reason: string): Promise<T> {
    if (!canUseDemoFallback) throw new ApiError(503, reason);
    logFallback(path, reason);
    try {
      return await mockApiFetch<T>(path, token, options);
    } catch (err: any) {
      if (err instanceof MockApiError) {
        if (err.status === 401) _unauthorizedHandler?.();
        throw new ApiError(err.status, err.message);
      }
      throw new ApiError(503, "Service démo temporairement indisponible.");
    }
  }

  async function runRealRequest(): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    } catch {
      throw new ApiError(0, "Connexion impossible. Vérifiez votre réseau.");
    }

    if (res.status === 401) {
      const msg = await readErrorMessage(res, "Session expirée. Reconnectez-vous.");
      _unauthorizedHandler?.();
      throw new ApiError(401, msg);
    }

    if (!res.ok) {
      const msg = await readErrorMessage(res, `Erreur ${res.status}`);
      throw new ApiError(res.status, msg);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = await res.text().catch(() => "");
      if (text.includes("<!DOCTYPE") || text.includes("<html")) {
        throw new ApiError(503, "Service temporairement indisponible. Réessayez dans un instant.");
      }
      throw new ApiError(503, "Réponse serveur invalide.");
    }

    try {
      const data = await res.json();
      logRealOk(path);
      return data as T;
    } catch {
      throw new ApiError(503, "Réponse serveur invalide.");
    }
  }

  if (!canUseDemoFallback) {
    return runRealRequest();
  }

  if (!canTryRealFirst) {
    return runMockFallback("session_demo_direct");
  }

  try {
    return await runRealRequest();
  } catch (err: any) {
    const status = typeof err?.status === "number" ? err.status : 503;
    if (isRecoverableNetworkError(status)) {
      return runMockFallback(err?.message ?? "real_api_unavailable");
    }
    throw err;
  }
}

export async function apiFetchSafe<T = unknown>(
  path: string,
  token: string | null,
  options: RequestInit = {}
): Promise<T | null> {
  try {
    return await apiFetch<T>(path, token, options);
  } catch {
    return null;
  }
}

export function formatXOF(amount: number | string): string {
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(n)) return "— XOF";
  return n.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " XOF";
}

export function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return "Il y a quelques secondes";
  const m = Math.floor(s / 60);
  if (m < 60) return `Il y a ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Il y a ${h}h`;
  const d = Math.floor(h / 24);
  return `Il y a ${d}j`;
}

export function generateIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
