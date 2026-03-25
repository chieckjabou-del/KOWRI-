export const DEV_SESSION_KEY = "kowri_dev_session";

export interface DevSession {
  token: string;
  developerId: string;
  developerName: string;
}

export function getDevSession(): DevSession | null {
  try {
    const raw = sessionStorage.getItem(DEV_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function setDevSession(session: DevSession): void {
  sessionStorage.setItem(DEV_SESSION_KEY, JSON.stringify(session));
}

export function clearDevSession(): void {
  sessionStorage.removeItem(DEV_SESSION_KEY);
}

export const devApiFetch = async <T>(
  path: string,
  token?: string,
  options: RequestInit = {}
): Promise<T> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
};
