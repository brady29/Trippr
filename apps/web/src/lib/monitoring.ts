import type { ErrorEvent } from "@sentry/browser";

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
let started = false;

/** Invite links carry their token in the path; query strings can carry anything. */
export function scrubUrl(url: string): string {
  return url.replace(/[?#].*$/, "").replace(/\/invite\/[^/]+/, "/invite/:token");
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) event.request = event.request.url ? { url: scrubUrl(event.request.url) } : {};
  delete event.user;
  delete event.breadcrumbs;
  return event;
}

/**
 * Reports uncaught browser errors to Sentry when NEXT_PUBLIC_SENTRY_DSN is
 * set. The SDK is loaded on demand, so builds without a DSN ship none of it.
 */
export function startErrorReporting(): void {
  if (!DSN || started || typeof window === "undefined") return;
  started = true;
  void import("@sentry/browser").then((Sentry) =>
    Sentry.init({
      dsn: DSN,
      release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
      environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      beforeSend: scrubEvent,
    }),
  );
}
