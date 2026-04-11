const API_PREFIX = "/api";
const RAW_BACKEND_BASE = ((import.meta as any).env?.VITE_BACKEND_API_BASE ?? "").trim();
const BACKEND_API_BASE = RAW_BACKEND_BASE.replace(/\/$/, "");
const USE_API_LOGS = ((import.meta as any).env?.VITE_API_LOGS ?? "false") === "true";

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

function normalizeApiPath(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.startsWith(API_PREFIX) ? p : `${API_PREFIX}${p}`;
}

function buildApiUrl(path: string): string {
  const normalized = normalizeApiPath(path);
  if (!BACKEND_API_BASE) return normalized;
  return `${BACKEND_API_BASE}${normalized}`;
}

function parseJsonText(text: string): any {
  if (!text.trim()) return null;
  return JSON.parse(text);
}

function extractErrorMessage(parsed: any, fallback: string): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
  if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
  return fallback;
}

export async function apiFetch<T = unknown>(
  path: string,
  token: string | null,
  options: RequestInit = {}
): Promise<T> {
  const url = buildApiUrl(path);
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, { ...options, headers });
  } catch {
    throw new ApiError(0, "Connexion impossible. Vérifiez votre réseau.");
  }

  const contentType = res.headers.get("content-type") ?? "";
  const rawText = await res.text().catch(() => "");
  const trimmed = rawText.trim();
  const looksLikeHtml =
    trimmed.startsWith("<") ||
    trimmed.includes("<!DOCTYPE") ||
    trimmed.includes("<html");

  if (looksLikeHtml) {
    throw new ApiError(res.ok ? 503 : res.status, "Réponse API invalide (HTML reçu au lieu de JSON)");
  }

  let parsed: any = null;
  try {
    parsed = parseJsonText(rawText);
  } catch {
    if (!res.ok) {
      throw new ApiError(res.status, `Erreur ${res.status}`);
    }
    throw new ApiError(502, "Réponse API invalide (JSON attendu)");
  }

  if (res.status === 401) {
    const msg = extractErrorMessage(parsed, "Session expirée. Reconnectez-vous.");
    _unauthorizedHandler?.();
    throw new ApiError(401, msg);
  }

  if (!res.ok) {
    const msg = extractErrorMessage(parsed, `Erreur ${res.status}`);
    throw new ApiError(res.status, msg);
  }

  if (!trimmed) {
    return null as T;
  }
  if (!contentType.includes("application/json") && typeof parsed === "string") {
    throw new ApiError(502, "Réponse API invalide (JSON attendu)");
  }

  if (USE_API_LOGS) {
    console.info("[API]", options.method ?? "GET", normalizeApiPath(path), "ok");
  }

  return parsed as T;
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
