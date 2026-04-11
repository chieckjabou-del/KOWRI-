import { isDemoToken, mockApiFetch, MockApiError } from "@/lib/mockApi";

const API_BASE = "/api";
const API_PREFIX = "/api";
const RAW_BACKEND_BASE = (import.meta.env.VITE_BACKEND_API_BASE ?? "").trim();
const BACKEND_API_BASE = RAW_BACKEND_BASE.replace(/\/+$/, "");
const USE_REAL_API = (import.meta.env.VITE_USE_REAL_API ?? "true") === "true";
const USE_API_LOGS = (import.meta.env.VITE_API_LOGS ?? "true") === "true";
const HYBRID_REAL_FIRST_ENDPOINTS = [
  /^\/auth\/login$/,
  /^\/auth\/register$/,
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

function normalizeApiPath(path: string): string {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function buildApiUrl(path: string): string {
  const normalized = normalizeApiPath(path);
  if (BACKEND_API_BASE) {
    return `${BACKEND_API_BASE}${API_PREFIX}${normalized}`;
  }
  return `${API_BASE}${normalized}`;
}

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

function extractErrorMessage(status: number, payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const message = p.message;
    const error = p.error;
    if (typeof message === "string" && message.trim()) return message;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback || `Erreur ${status}`;
}

async function safeFetchJson<T>(
  path: string,
  options: RequestInit,
  onUnauthorized: () => void,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildApiUrl(path), options);
  } catch {
    throw new ApiError(0, "Connexion impossible. Vérifiez votre réseau.");
  }

  const rawText = await res.text().catch(() => "");
  const trimmed = rawText.trim();
  const looksLikeHtml =
    trimmed.startsWith("<") ||
    trimmed.includes("<!DOCTYPE") ||
    trimmed.includes("<html");

  // Anti-HTML guard: backend/proxy returned HTML instead of JSON payload.
  if (looksLikeHtml) {
    throw new ApiError(
      res.ok ? 503 : res.status,
      "API returned HTML instead of JSON",
    );
  }

  let parsed: unknown = null;
  if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ApiError(503, "Réponse serveur invalide.");
    }
  }

  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, extractErrorMessage(401, parsed, "Session expirée. Reconnectez-vous."));
  }

  if (!res.ok) {
    throw new ApiError(res.status, extractErrorMessage(res.status, parsed, `Erreur ${res.status}`));
  }

  logRealOk(path);
  return parsed as T;
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
    try {
      return await safeFetchJson<T>(path, { ...options, headers }, () => _unauthorizedHandler?.());
    } catch (err) {
      if (USE_API_LOGS) console.error("API ERROR:", err);
      throw err;
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
