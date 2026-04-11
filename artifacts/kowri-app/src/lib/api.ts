import { isDemoToken, mockApiFetch, MockApiError } from "@/lib/mockApi";

const API_BASE = "/api";

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
  if (isDemoToken(token)) {
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

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (networkErr: any) {
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
    return await res.json();
  } catch {
    throw new ApiError(503, "Réponse serveur invalide.");
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
