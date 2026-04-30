import { trackApiFailure, trackApiLatency } from "@/lib/frontendMonitor";

function resolveApiBase(): string {
  const raw = import.meta.env.VITE_API_BASE?.trim();
  if (!raw) return "/api";
  const normalized = raw.replace(/\/$/, "");
  return normalized.endsWith("/api") ? normalized : `${normalized}/api`;
}

const API_BASE = resolveApiBase();

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

interface ApiFetchPolicy {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

interface ApiFetchOptions extends RequestInit {
  policy?: ApiFetchPolicy;
}

let _unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(cb: () => void): void {
  _unauthorizedHandler = cb;
}

export function buildApiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(method: string, status: number): boolean {
  const idempotent = method === "GET" || method === "HEAD";
  if (!idempotent) return false;
  return status === 0 || status >= 500 || status === 429;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  token: string | null,
  options: ApiFetchOptions = {}
): Promise<T> {
  const { policy, ...requestInit } = options;
  const method = (requestInit.method ?? "GET").toUpperCase();
  const timeoutMs = policy?.timeoutMs ?? (method === "GET" ? 8_000 : 14_000);
  const retries = policy?.retries ?? (method === "GET" ? 1 : 0);
  const retryDelayMs = policy?.retryDelayMs ?? 450;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(requestInit.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let attempt = 0;
  let lastError: ApiError | null = null;

  const startedAt = Date.now();
  while (attempt <= retries) {
    let res: Response;
    try {
      res = await fetchWithTimeout(buildApiUrl(path), { ...requestInit, headers }, timeoutMs);
    } catch {
      const networkError = new ApiError(0, "Connexion lente ou indisponible. Vérifiez votre réseau.");
      trackApiFailure(path, method, networkError.status, networkError.message);
      if (attempt < retries && shouldRetry(method, networkError.status)) {
        attempt += 1;
        await wait(retryDelayMs * attempt);
        continue;
      }
      throw networkError;
    }

    if (res.status === 401) {
      let msg = "Session expirée. Reconnectez-vous.";
      try {
        const j = await res.json();
        msg = j.message || j.error || msg;
      } catch {}
      _unauthorizedHandler?.();
      trackApiFailure(path, method, 401, msg);
      throw new ApiError(401, msg);
    }

    if (!res.ok) {
      let msg = `Erreur ${res.status}`;
      try {
        const j = await res.json();
        msg = j.message || j.error || msg;
      } catch {}
      const failure = new ApiError(res.status, msg);
      trackApiFailure(path, method, failure.status, failure.message);
      if (attempt < retries && shouldRetry(method, failure.status)) {
        lastError = failure;
        attempt += 1;
        await wait(retryDelayMs * attempt);
        continue;
      }
      throw failure;
    }

    trackApiLatency(path, Date.now() - startedAt, method);
    return res.json();
  }

  throw lastError ?? new ApiError(0, "Connexion impossible. Vérifiez votre réseau.");
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
