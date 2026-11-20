import type { Config } from "./config";

export interface ErrorContext {
  method: string;
  /** The route pattern ("/trips/:id"), never the raw URL: query strings can hold the webhook secret. */
  route: string;
}

export interface ErrorReporter {
  capture(error: unknown, context?: ErrorContext): void;
  close(): Promise<void>;
}

/**
 * Reports unexpected errors to Sentry when SENTRY_DSN is set; otherwise does
 * nothing and the SDK is never loaded. Only the error, its stack and the route
 * pattern are sent: no request bodies, headers, users or breadcrumbs, since
 * those can hold booking references, emails and tokens.
 */
export async function startErrorReporting(config: Config): Promise<ErrorReporter | undefined> {
  if (!config.SENTRY_DSN) return undefined;
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: config.SENTRY_DSN,
    release: config.SENTRY_RELEASE,
    environment: config.NODE_ENV,
    sendDefaultPii: false,
    defaultIntegrations: false,
    integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration({ mode: "warn" })],
    maxBreadcrumbs: 0,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.breadcrumbs;
      return event;
    },
  });
  return {
    capture(error, context) {
      Sentry.captureException(error, context ? { tags: { method: context.method, route: context.route } } : undefined);
    },
    async close() {
      await Sentry.close(2000);
    },
  };
}
