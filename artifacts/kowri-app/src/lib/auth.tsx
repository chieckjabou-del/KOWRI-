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

function readStoredSession(): AuthState {
  try {
    const raw = localStorage.getItem(LS_KEY) || sessionStorage.getItem(SS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.token && parsed?.user) return parsed;
    }
  } catch {}
  return { token: null, user: null };
}

function writeSession(state: AuthState): void {
  try {
    if (state.token) {
      const raw = JSON.stringify(state);
      localStorage.setItem(LS_KEY, raw);
      sessionStorage.setItem(SS_KEY, raw);
    } else {
      localStorage.removeItem(LS_KEY);
      sessionStorage.removeItem(SS_KEY);
    }
  } catch {}
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
    console.log("[AUTH] Rehydrating session…", { hasToken: !!stored.token });

    if (!stored.token) {
      console.log("[AUTH] No stored token → unauthenticated");
      setIsHydrating(false);
      return;
    }

    validateToken(stored.token).then((freshUser) => {
      if (freshUser) {
        console.log("[AUTH] Token valid → restoring session", freshUser.id);
        const nextState = { token: stored.token, user: freshUser };
        setAuth(nextState);
        writeSession(nextState);
      } else {
        console.log("[AUTH] Token invalid/expired → clearing session");
        writeSession({ token: null, user: null });
        setAuth({ token: null, user: null });
      }
      setIsHydrating(false);
    });
  }, []);

  const login = useCallback((token: string, user: AuthUser) => {
    console.log("[AUTH] Login →", user.id);
    const next = { token, user };
    setAuth(next);
    writeSession(next);
  }, []);

  const logout = useCallback(() => {
    console.log("[AUTH] Logout");
    writeSession({ token: null, user: null });
    setAuth({ token: null, user: null });
  }, []);

  const clearAuth = useCallback(() => {
    console.log("[AUTH] clearAuth (401 intercept)");
    writeSession({ token: null, user: null });
    setAuth({ token: null, user: null });
  }, []);

  useEffect(() => {
    console.log("[AUTH STATE]", {
      token: auth.token ? auth.token.slice(0, 8) + "…" : null,
      user: auth.user?.id ?? null,
      isHydrating,
    });
  }, [auth, isHydrating]);

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
