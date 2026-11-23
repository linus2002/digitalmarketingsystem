import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";

export interface User {
  id: number;
  email: string;
  name: string;
  role: string;
  roleLabel: string;
  permissions: string[];
}

interface AuthState {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (perm: string) => boolean;
  /** True when the server said the session ended while someone was using the app. The page stays mounted
   *  (so unsaved work survives) and a sign-in dialog is shown over it. */
  sessionExpired: boolean;
  /** Reloads the signed-in user (e.g. after they changed their own name). */
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const userRef = useRef<User | null>(null);
  userRef.current = user;

  useEffect(() => {
    api<{ user: User }>("/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
    // Keep the current page (and whatever was typed into it); ask to sign in again over it.
    const onExpired = () => {
      if (userRef.current) setSessionExpired(true);
    };
    window.addEventListener("session-expired", onExpired);
    return () => window.removeEventListener("session-expired", onExpired);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ user: User }>("/auth/login", { body: { email, password } });
    const before = userRef.current;
    setSessionExpired(false);
    if (before && before.id !== r.user.id) {
      // Someone else signed in on the expired page: don't show them the previous person's screen.
      window.location.assign("/");
      return;
    }
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setSessionExpired(false);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: User }>("/auth/me");
      setUser(r.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && userRef.current) setSessionExpired(true);
    }
  }, []);

  const can = useCallback((perm: string) => !!user?.permissions.includes(perm), [user]);

  return <Ctx.Provider value={{ user, ready, login, logout, can, sessionExpired, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
