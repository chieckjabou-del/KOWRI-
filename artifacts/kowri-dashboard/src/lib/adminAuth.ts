export const ADMIN_KEY_STORAGE = "kowri_admin_key";

export function getAdminKey(): string | null {
  try {
    const stored = sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (stored) return stored;
  } catch { /* storage unavailable */ }
  const fromEnv = import.meta.env.VITE_ADMIN_API_KEY as string | undefined;
  return fromEnv || null;
}

export function setAdminKey(key: string): void {
  sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
}

export function clearAdminKey(): void {
  sessionStorage.removeItem(ADMIN_KEY_STORAGE);
}

// Attaches X-Admin-Key to every same-origin /api call so admin pages keep working
// now that the backend gates admin routes.
export function installAdminFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isApi = url.startsWith("/api/") || url.startsWith(`${window.location.origin}/api/`);
    const key = isApi ? getAdminKey() : null;
    if (!key) return original(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("X-Admin-Key")) headers.set("X-Admin-Key", key);
    return original(input, { ...init, headers });
  };
}
