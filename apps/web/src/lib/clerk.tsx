"use client";

import { ClerkProvider, SignInButton, useAuth as useClerkAuth, useClerk, useUser } from "@clerk/nextjs";
import { useEffect, useRef, type ReactNode } from "react";
import { useAuth } from "./auth";

export const CLERK_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";

export function MaybeClerkProvider({ children }: { children: ReactNode }) {
  if (!CLERK_KEY) return <>{children}</>;
  return <ClerkProvider publishableKey={CLERK_KEY}>{children}</ClerkProvider>;
}

/** Reports Clerk's session to the Trippr auth provider. Rendered only when Clerk is configured. */
export function ClerkBridge() {
  const { setClerkState } = useAuth();
  const { isLoaded, isSignedIn, getToken } = useClerkAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const name = user?.fullName ?? user?.username ?? undefined;
  const email = user?.primaryEmailAddress?.emailAddress ?? undefined;

  useEffect(() => {
    setClerkState({
      loaded: isLoaded,
      signedIn: Boolean(isSignedIn),
      getToken: () => getTokenRef.current(),
      profile: name || email ? { name, email } : undefined,
      signOut: () => clerk.signOut(),
    });
  }, [isLoaded, isSignedIn, name, email, clerk, setClerkState]);

  return null;
}

export function ClerkSignIn({ children }: { children: ReactNode }) {
  return <SignInButton mode="modal">{children}</SignInButton>;
}
