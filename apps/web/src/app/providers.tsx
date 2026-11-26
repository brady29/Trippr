"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ToastProvider } from "@/components/toast";
import { ApiError } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import { CLERK_KEY, ClerkBridge, MaybeClerkProvider } from "@/lib/clerk";
import { startErrorReporting } from "@/lib/monitoring";

export function Providers({ children }: { children: ReactNode }) {
  useEffect(startErrorReporting, []);
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
          },
          mutations: {
            // A dropped connection on café Wi-Fi shouldn't lose a change: try again, waiting longer each time.
            retry: (count, error) => error instanceof ApiError && error.code === "network" && count < 4,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15_000),
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MaybeClerkProvider>
          <AuthProvider clerkEnabled={Boolean(CLERK_KEY)}>
            {CLERK_KEY ? <ClerkBridge /> : null}
            {children}
          </AuthProvider>
        </MaybeClerkProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
