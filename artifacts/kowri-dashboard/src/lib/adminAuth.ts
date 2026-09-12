// Back-office authentication for the dashboard.
//
// Operators sign in with a named account (email + password) and receive a
// short-lived admin token that every same-origin /api call carries in
// `X-Admin-Token`. The shared `VITE_ADMIN_API_KEY` is still honoured as a
// legacy fallback so an existing deployment keeps working until it is unset.

export const ADMIN_SESSION_STORAGE = "kowri_admin_session";
export const ADMIN_KEY_STORAGE = "kowri_admin_key";

export interface AdminAccount {
  id: string;
  email: string;
  name: string;
  role: string;
  permissions: string[];
  mustChangePassword: boolean;
}

export interface AdminSession {
  token: string;
  expiresAt: string;
  admin: AdminAccount;
}

type Listener = () => void;
const listeners = new Set<Listener>();
function notify() { listeners.forEach((l) => l()); }
export function subscribeAdminSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getAdminSession(): AdminSession | null {
  try {
    const raw = sessionStorage.getItem(ADMIN_SESSION_STORAGE);
    if (!raw) return null;
    const session = JSON.parse(raw) as AdminSession;
    if (!session?.token || new Date(session.expiresAt).getTime() < Date.now()) {
      sessionStorage.removeItem(ADMIN_SESSION_STORAGE);
      return null;
    }
    return session;
  } catch { return null; }
}

export function setAdminSession(session: AdminSession): void {
  sessionStorage.setItem(ADMIN_SESSION_STORAGE, JSON.stringify(session));
  notify();
}

export function clearAdminSession(): void {
  sessionStorage.removeItem(ADMIN_SESSION_STORAGE);
  notify();
}

export function getLegacyAdminKey(): string | null {
  try {
    const stored = sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (stored) return stored;
  } catch { /* storage unavailable */ }
  const fromEnv = import.meta.env.VITE_ADMIN_API_KEY as string | undefined;
  return fromEnv || null;
}

// Who the dashboard is acting as: a named account, the legacy shared key, or nobody.
export function currentOperator(): AdminAccount | null {
  const session = getAdminSession();
  if (session) return session.admin;
  if (getLegacyAdminKey()) {
    return { id: "legacy-key", email: "", name: "Clé partagée", role: "super_admin", permissions: ["*"], mustChangePassword: false };
  }
  return null;
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super administrateur",
  compliance: "Conformité",
  operations: "Opérations",
  support: "Support",
  auditor: "Auditeur (lecture seule)",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export function hasPermission(permission: string): boolean {
  const operator = currentOperator();
  if (!operator) return false;
  return operator.permissions.includes("*") || operator.permissions.includes(permission);
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text || res.statusText }; }
}

export async function adminLogin(email: string, password: string): Promise<AdminSession> {
  const res = await fetch("/api/admin/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(body.error || `Connexion refusée (${res.status})`);
  const session: AdminSession = { token: body.token, expiresAt: body.expiresAt, admin: body.admin };
  setAdminSession(session);
  return session;
}

export async function adminLogout(): Promise<void> {
  const session = getAdminSession();
  if (session) {
    await fetch("/api/admin/auth/logout", { method: "POST", headers: { "X-Admin-Token": session.token } }).catch(() => undefined);
  }
  clearAdminSession();
}

export async function adminChangePassword(currentPassword: string, newPassword: string): Promise<void> {
  const session = getAdminSession();
  if (!session) throw new Error("Session expirée");
  const res = await fetch("/api/admin/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": session.token },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(body.error || `Échec (${res.status})`);
  setAdminSession({ ...session, admin: { ...session.admin, mustChangePassword: false } });
}

// Attaches the operator credential to every same-origin /api call. A 401 on an
// admin token means the session was revoked or expired: drop it so the login
// screen comes back instead of a page full of failed requests.
export function installAdminFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isApi = url.startsWith("/api/") || url.startsWith(`${window.location.origin}/api/`);
    if (!isApi) return original(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const session = getAdminSession();
    if (session && !headers.has("X-Admin-Token")) headers.set("X-Admin-Token", session.token);
    const legacy = session ? null : getLegacyAdminKey();
    if (legacy && !headers.has("X-Admin-Key")) headers.set("X-Admin-Key", legacy);

    const res = await original(input, { ...init, headers });
    if (res.status === 401 && session && headers.get("X-Admin-Token") === session.token && !url.includes("/admin/auth/login")) {
      const probe = await original("/api/admin/auth/introspect", { headers: { "X-Admin-Token": session.token } }).catch(() => null);
      if (probe && probe.status === 401) clearAdminSession();
    }
    return res;
  };
}
