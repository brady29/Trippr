import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError, type ZodTypeAny, type z } from "zod";
import { createAuth, type Auth, type AuthUser } from "./auth";
import type { Config } from "./config";
import type { GraphClient } from "./db/graph";
import { AppError, badRequest, forbidden, unauthorized } from "./errors";
import { createRepositories, type Repositories } from "./repositories";
import { preloadQueries } from "./repositories/queries";
import { activityRoutes } from "./routes/activities";
import { authRoutes } from "./routes/auth";
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
  /** The signed-in caller; throws 401 when there is none. */
  user(req: FastifyRequest): AuthUser;
  parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S>;
}

export interface BuildOptions {
  config: Config;
  db: GraphClient;
  logger?: boolean | object;
}

export async function buildApp({ config, db, logger = true }: BuildOptions): Promise<FastifyInstance> {
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

  const ctx: AppContext = {
    config,
    db,
    repos,
    auth,
    guards: createGuards(repos),
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
  });

  return app;
}
