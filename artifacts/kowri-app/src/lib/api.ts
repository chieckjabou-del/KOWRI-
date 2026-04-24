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

export async function apiFetch<T = unknown>(
  path: string,
  token: string | null,
  options: RequestInit = {}
): Promise<T> {
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
    let msg = "Session expirée. Reconnectez-vous.";
    try { const j = await res.json(); msg = j.message || j.error || msg; } catch {}
    _unauthorizedHandler?.();
    throw new ApiError(401, msg);
  }

  if (!res.ok) {
    let msg = `Erreur ${res.status}`;
    try { const j = await res.json(); msg = j.message || j.error || msg; } catch {}
    throw new ApiError(res.status, msg);
  }

  return res.json();
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
