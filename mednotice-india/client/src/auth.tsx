import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import type { User } from "./types";

/** Response of the one-time-password endpoints. `devCode` is only set in simulation. */
export type OtpChallenge = {
  challengeId: string;
  expiresAt: string;
  /** Where the code went: SMS to a mobile number, email to a mailbox. */
  channel?: "SMS" | "EMAIL";
  masked: string;
  sentTo?: string;
  simulated: boolean;
  devCode: string | null;
};

type AuthState = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  signup: (input: { name: string; email: string; password: string; phone?: string }) => Promise<User>;
  /** Ask the server for a code sent to the patient's mobile number or email. */
  startOtp: (identifier: string) => Promise<OtpChallenge>;
  /** Exchange a valid one-time password for a session. */
  loginWithOtp: (challengeId: string, code: string) => Promise<User>;
  logout: () => Promise<void>;
  refresh: () => Promise<User | null>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user: current } = await api.get<{ user: User | null }>("/api/auth/me");
      setUser(current);
      return current;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const { user: next } = await api.post<{ user: User }>("/api/auth/login", { email, password });
    setUser(next);
    return next;
  }, []);

  const signup = useCallback(async (input: { name: string; email: string; password: string; phone?: string }) => {
    const { user: next } = await api.post<{ user: User }>("/api/auth/signup", { ...input, consent: true });
    setUser(next);
    return next;
  }, []);

  const startOtp = useCallback(async (identifier: string) => {
    return api.post<OtpChallenge>("/api/auth/otp/request", { identifier });
  }, []);

  const loginWithOtp = useCallback(async (challengeId: string, code: string) => {
    const { user: next } = await api.post<{ user: User }>("/api/auth/otp/verify", { challengeId, code });
    setUser(next);
    return next;
  }, []);

  const logout = useCallback(async () => {
    await api.post("/api/auth/logout");
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, signup, startOtp, loginWithOtp, logout, refresh }),
    [user, loading, login, signup, startOtp, loginWithOtp, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export const STAFF_ROLES = ["SUPER_ADMIN", "MINISTRY_REVIEWER", "HOSPITAL_COMPLIANCE", "SYSTEM_AUDITOR"];
export const REVIEWER_ROLES = ["SUPER_ADMIN", "MINISTRY_REVIEWER", "HOSPITAL_COMPLIANCE"];
