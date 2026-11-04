import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

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
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api<{ user: User }>("/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
    const onExpired = () => setUser(null);
    window.addEventListener("session-expired", onExpired);
    return () => window.removeEventListener("session-expired", onExpired);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ user: User }>("/auth/login", { body: { email, password } });
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
  }, []);

  const can = useCallback((perm: string) => !!user?.permissions.includes(perm), [user]);

  return <Ctx.Provider value={{ user, ready, login, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
