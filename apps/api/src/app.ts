import cors from "@fastify/cors";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest, type InjectOptions } from "fastify";
import { ZodError, type ZodTypeAny, type z } from "zod";
import { createAuth, type Auth, type AuthUser } from "./auth";
import type { Config } from "./config";
import type { GraphClient } from "./db/graph";
import { AppError, badRequest, forbidden, unauthorized } from "./errors";
import { LiveHub, type LiveChange } from "./live";
import { createRepositories, type Repositories } from "./repositories";
import { preloadQueries } from "./repositories/queries";
import { activityRoutes } from "./routes/activities";
import { authRoutes } from "./routes/auth";
import { explorerRoutes } from "./routes/explorer";
import { liveRoutes } from "./routes/live";
import { travelRoutes } from "./routes/travel";
import { bookingsRoutes } from "./routes/bookings";
import { calendarRoutes } from "./routes/calendar";
import { inboxRoutes } from "./routes/inbox";
import { createInbox, type Inbox } from "./services/inbox/service";
import { createNominatim, noGeocoder, type Geocoder } from "./services/places/geocoder";
import { createPlaces, type Places } from "./services/places/service";
import { basicReader, createClaudeReader, type InboxReader } from "./services/inbox/reader";
import { metaRoutes } from "./routes/meta";
import { routeRoutes } from "./routes/routes";
import { tripRoutes } from "./routes/trips";
import { createGuards, type Guards } from "./services/guards";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

export interface AppContext {
  config: Config;
  db: GraphClient;
  repos: Repositories;
  auth: Auth;
  guards: Guards;
  live: LiveHub;
  /** Tell everyone viewing the trip that `by` just changed something. */
  notify(tripId: string, change: LiveChange, by: string): void;
  /** Reads inbox messages (Claude when configured, otherwise links only). */
  inboxReader: InboxReader;
  inbox: Inbox;
  /** Finds and sets activity pins. */
  places: Places;
  log: FastifyBaseLogger;
  /** Calls this API in-process, e.g. to apply an inbox item as the person who sent it. */
  inject(opts: InjectOptions): Promise<{ statusCode: number; json(): unknown; body: string }>;
  /** The signed-in caller; throws 401 when there is none. */
  user(req: FastifyRequest): AuthUser;
  parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S>;
}

export interface BuildOptions {
  config: Config;
  db: GraphClient;
  logger?: boolean | object;
  /** Overrides the inbox reader (tests). */
  inboxReader?: InboxReader;
  /** Receives unexpected (500) errors, e.g. to report them to Sentry. */
  onError?: (error: unknown, context: { method: string; route: string }) => void;
  /** Overrides the geocoder and short-link resolver (tests). */
  geocoder?: Geocoder;
  resolveShortLink?: (url: string) => Promise<string | null>;
}

export async function buildApp({
  config,
  db,
  logger = true,
  inboxReader,
  onError,
  geocoder,
  resolveShortLink,
}: BuildOptions): Promise<FastifyInstance> {
  preloadQueries(db.dialect);
  const app = Fastify({
    logger: logger === true ? { level: config.LOG_LEVEL } : logger,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(cors, {
    origin: config.WEB_ORIGIN.split(",").map((o) => o.trim()),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  });

  const repos = createRepositories(db);
  const auth = createAuth(config);
  const knownUsers = new Map<string, number>();
  const live = new LiveHub();
  app.addHook("onClose", async () => live.closeAll());

  // Verify the bearer token (if any) and map it to a User node.
  app.addHook("preHandler", async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return;
    const user = await auth.verify(header.slice(7));
    const seen = knownUsers.get(user.id);
    if (!seen || Date.now() - seen > 10 * 60_000) {
      await repos.users.upsert(user);
      knownUsers.set(user.id, Date.now());
    }
    req.authUser = user;
    // The demo account can look at everything it is invited to and change nothing.
    if (user.isDemo && req.method !== "GET" && req.method !== "HEAD") {
      throw forbidden("The demo account is read-only");
    }
  });

  const reader =
    inboxReader ?? (config.ANTHROPIC_API_KEY ? createClaudeReader({ apiKey: config.ANTHROPIC_API_KEY, model: config.INBOX_MODEL }) : basicReader);
  const ctx: AppContext = {
    inboxReader: reader,
    inbox: undefined as unknown as Inbox,
    places: createPlaces({
      repos,
      geocoder: geocoder ?? (config.GEOCODER === "nominatim" ? createNominatim({ userAgent: config.GEOCODER_USER_AGENT }) : noGeocoder),
      resolveShortLink,
    }),
    log: app.log,
    inject: (opts) => app.inject(opts),
    config,
    db,
    repos,
    auth,
    guards: createGuards(repos),
    live,
    notify(tripId, change, by) {
      live.publish(tripId, change, by);
    },
    user(req) {
      if (!req.authUser) throw unauthorized();
      return req.authUser;
    },
    parse(schema, data) {
      const result = schema.safeParse(data ?? {});
      if (!result.success) throw badRequest("Invalid request", result.error.flatten());
      return result.data;
    },
  };

  ctx.inbox = createInbox(ctx);

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: { code: "bad_request", message: "Invalid request", details: error.flatten() } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: "bad_request", message: error.message } });
    }
    req.log.error({ err: error }, "unhandled error");
    onError?.(error, { method: req.method, route: req.routeOptions.url ?? "unknown" });
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong" } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: "not_found", message: `No route for ${req.method} ${req.url}` } }),
  );

  await app.register(async (scope) => {
    metaRoutes(scope, ctx);
    authRoutes(scope, ctx);
    tripRoutes(scope, ctx);
    routeRoutes(scope, ctx);
    activityRoutes(scope, ctx);
    liveRoutes(scope, ctx);
    travelRoutes(scope, ctx);
    bookingsRoutes(scope, ctx);
    inboxRoutes(scope, ctx);
    explorerRoutes(scope, ctx);
    calendarRoutes(scope, ctx);
  });

  return app;
}
