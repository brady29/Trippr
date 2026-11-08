"use client";

import type { AuthToken, Me } from "@trippr/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, setTokenGetter, storage } from "./api";

const TOKEN_KEY = "trippr.token";

export interface ClerkState {
  loaded: boolean;
  signedIn: boolean;
  getToken?: () => Promise<string | null>;
  profile?: { name?: string; email?: string };
  signOut?: () => Promise<void>;
}

interface AuthConfig {
  devLogin: boolean;
  demo: boolean;
  external: boolean;
}

interface AuthContextValue {
  status: "loading" | "signedIn" | "signedOut";
  me: Me | null;
  config: AuthConfig | undefined;
  clerkEnabled: boolean;
  signInDev(name: string, email?: string): Promise<void>;
  signInDemo(): Promise<void>;
  signOut(): Promise<void>;
  /** Used by the Clerk bridge to report its state. */
  setClerkState(state: ClerkState): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Two token sources: one this API issued (dev sign-in, demo), kept in
 * localStorage, and the Clerk session when Clerk is configured. A local
 * token wins so the demo works on a deployment that also has Clerk.
 */
export function AuthProvider({ children, clerkEnabled }: { children: ReactNode; clerkEnabled: boolean }) {
  const queryClient = useQueryClient();
  const [localToken, setLocalToken] = useState<string | null | undefined>(undefined);
  const [clerk, setClerk] = useState<ClerkState>({ loaded: !clerkEnabled, signedIn: false });
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthContextValue["status"]>("loading");
  const clerkRef = useRef(clerk);
  clerkRef.current = clerk;
  const localRef = useRef(localToken);
  localRef.current = localToken;

  // Register the token getter during the first render: child components'
  // effects (and their queries) run before this provider's effects.
  useState(() => {
    setTokenGetter(async () => {
      if (localRef.current === undefined) localRef.current = storage.get(TOKEN_KEY);
      if (localRef.current) return localRef.current;
      const c = clerkRef.current;
      return c.signedIn && c.getToken ? c.getToken() : null;
    });
    return null;
  });

  const config = useQuery({
    queryKey: ["auth-config"],
    queryFn: () => api<AuthConfig>("/auth/config"),
    staleTime: Infinity,
    retry: 1,
  });

  useEffect(() => {
    setLocalToken(storage.get(TOKEN_KEY));
  }, []);

  useEffect(() => {
    if (localToken === undefined || !clerk.loaded) return;
    if (!localToken && !clerk.signedIn) {
      setMe(null);
      setStatus("signedOut");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        let user = await api<Me>("/me");
        const profile = clerk.profile;
        // Clerk session tokens carry no name by default; copy it from the Clerk profile once.
        if (!localToken && profile?.name && user.name === "Traveller") {
          user = (await api<Me>("/me", { method: "PATCH", body: profile })) ?? user;
        }
        if (!cancelled) {
          setMe(user);
          setStatus("signedIn");
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401 && localToken) {
          storage.set(TOKEN_KEY, null);
          setLocalToken(null);
        }
        setMe(null);
        setStatus("signedOut");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [localToken, clerk.loaded, clerk.signedIn, clerk.profile]);

  const adoptToken = useCallback(
    (auth: AuthToken) => {
      queryClient.clear();
      storage.set(TOKEN_KEY, auth.token);
      setLocalToken(auth.token);
    },
    [queryClient],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      me,
      config: config.data,
      clerkEnabled,
      async signInDev(name, email) {
        adoptToken(await api<AuthToken>("/auth/dev-login", { method: "POST", body: { name, ...(email ? { email } : {}) } }));
      },
      async signInDemo() {
        adoptToken(await api<AuthToken>("/auth/demo", { method: "POST" }));
      },
      async signOut() {
        queryClient.clear();
        storage.set(TOKEN_KEY, null);
        setLocalToken(null);
        if (!localToken && clerk.signOut) await clerk.signOut();
      },
      setClerkState: setClerk,
    }),
    [status, me, config.data, clerkEnabled, adoptToken, queryClient, localToken, clerk],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
