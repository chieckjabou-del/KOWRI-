import { trackApiFailure, trackApiLatency } from "@/lib/frontendMonitor";

function resolveApiBase(): string {
  const raw = (
    import.meta.env.VITE_API_URL?.trim() ??
    "https://workspaceapi-server-production-c114.up.railway.app/"
  );
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
  dedupe?: boolean;
  dedupeKey?: string;
}

interface ApiFetchOptions extends RequestInit {
  policy?: ApiFetchPolicy;
}

let _unauthorizedHandler: (() => void) | null = null;
const inflightGetRequests = new Map<string, Promise<unknown>>();

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
  externalSignal?: AbortSignal | null,
): Promise<Response> {
  const mergeSignals = (...signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined => {
    const validSignals = signals.filter(Boolean) as AbortSignal[];
    if (validSignals.length === 0) return undefined;
    if (validSignals.length === 1) return validSignals[0];
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
      return AbortSignal.any(validSignals);
    }
    const controller = new AbortController();
    for (const signal of validSignals) {
      if (signal.aborted) {
        controller.abort();
        return controller.signal;
      }
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return controller.signal;
  };

  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return fetch(input, {
      ...init,
      signal: mergeSignals(AbortSignal.timeout(timeoutMs), externalSignal ?? undefined),
    });
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: mergeSignals(controller.signal, externalSignal ?? undefined),
    });
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
  const dedupeEnabled = method === "GET" && policy?.dedupe !== false;
  const dedupeKey = dedupeEnabled
    ? (policy?.dedupeKey ?? `${method}:${path}:${token ?? "anon"}`)
    : null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(requestInit.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const runRequest = async (): Promise<T> => {
    let attempt = 0;
    let lastError: ApiError | null = null;
    const startedAt = Date.now();

    while (attempt <= retries) {
      let res: Response;
      try {
        res = await fetchWithTimeout(
          buildApiUrl(path),
          { ...requestInit, headers },
          timeoutMs,
          requestInit.signal,
        );
      } catch (error) {
        const abortedByCaller =
          Boolean(requestInit.signal?.aborted) ||
          (error instanceof DOMException && error.name === "AbortError");
        if (abortedByCaller) {
          throw new ApiError(499, "Requête annulée.");
        }
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
  };

  if (!dedupeKey) {
    return runRequest();
  }

  const inflight = inflightGetRequests.get(dedupeKey);
  if (inflight) {
    return inflight as Promise<T>;
  }

  const promise = runRequest().finally(() => {
    inflightGetRequests.delete(dedupeKey);
  });
  inflightGetRequests.set(dedupeKey, promise as Promise<unknown>);
  return promise;
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
