import {
  createContext, useContext, useState, useEffect, useCallback, ReactNode,
} from "react";

export interface AuthUser {
  id: string;
  phone: string;
  firstName: string;
  lastName: string;
  status: string;
  country: string;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
}

interface AuthContextType extends AuthState {
  isHydrating: boolean;
  isAuthenticated: boolean;
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
  clearAuth: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const LS_KEY  = "kowri_auth_v2";
const SS_KEY  = "kowri_auth";

// Server sessions live 24 h; a stored token older than that is dropped without
// a round-trip, and the stored copy carries no more than the token and the
// user's public profile. The token stays in web storage because the app is
// installed as a PWA and must survive a closed tab; the server-side revocation
// on logout and the 24 h ceiling bound the exposure of a stolen copy.
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

function readStoredSession(): AuthState {
  try {
    const raw = localStorage.getItem(LS_KEY) || sessionStorage.getItem(SS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const fresh = typeof parsed?.savedAt !== "number" || Date.now() - parsed.savedAt < MAX_SESSION_AGE_MS;
      if (parsed?.token && parsed?.user && fresh) return { token: parsed.token, user: parsed.user };
      if (!fresh) writeSession({ token: null, user: null });
    }
  } catch {}
  return { token: null, user: null };
}

function writeSession(state: AuthState): void {
  try {
    if (state.token) {
      const raw = JSON.stringify({ token: state.token, user: state.user, savedAt: Date.now() });
      localStorage.setItem(LS_KEY, raw);
      sessionStorage.setItem(SS_KEY, raw);
    } else {
      localStorage.removeItem(LS_KEY);
      sessionStorage.removeItem(SS_KEY);
    }
  } catch {}
}

// Logout revokes the server session so a copied token stops working immediately.
function revokeServerSession(token: string | null): void {
  if (!token) return;
  fetch("/api/wallet/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
}

async function validateToken(token: string): Promise<AuthUser | null> {
  try {
    const res = await fetch("/api/users/me", {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.user ?? null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ token: null, user: null });
  const [isHydrating, setIsHydrating] = useState(true);

  useEffect(() => {
    const stored = readStoredSession();

    if (!stored.token) {
      setIsHydrating(false);
      return;
    }

    validateToken(stored.token).then((freshUser) => {
      if (freshUser) {
        const nextState = { token: stored.token, user: freshUser };
        setAuth(nextState);
        writeSession(nextState);
      } else {
        writeSession({ token: null, user: null });
        setAuth({ token: null, user: null });
      }
      setIsHydrating(false);
    });
  }, []);

  const login = useCallback((token: string, user: AuthUser) => {
    const next = { token, user };
    setAuth(next);
    writeSession(next);
  }, []);

  const logout = useCallback(() => {
    revokeServerSession(auth.token);
    writeSession({ token: null, user: null });
    setAuth({ token: null, user: null });
  }, [auth.token]);

  const clearAuth = useCallback(() => {
    writeSession({ token: null, user: null });
    setAuth({ token: null, user: null });
  }, []);

  return (
    <AuthContext.Provider
      value={{
        ...auth,
        isHydrating,
        isAuthenticated: !!auth.token && !!auth.user,
        login,
        logout,
        clearAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
