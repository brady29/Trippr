import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  /** Which Cypher database the repository layer talks to. */
  DB_DIALECT: z.enum(["falkordb", "neo4j"]).default("falkordb"),
  FALKORDB_URL: z.string().default("redis://localhost:6379"),
  FALKORDB_GRAPH: z.string().default("trippr"),
  NEO4J_URI: z.string().default("neo4j://localhost:7687"),
  NEO4J_USER: z.string().default("neo4j"),
  NEO4J_PASSWORD: z.string().default(""),
  NEO4J_DATABASE: z.string().optional(),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().default(5000),

  /** Signs the tokens this API issues itself (dev sign-in and the demo account). */
  APP_JWT_SECRET: z.string().min(32, "APP_JWT_SECRET must be at least 32 characters"),
  /** Enables POST /auth/dev-login. Never turn this on in production. */
  AUTH_DEV_LOGIN: bool,
  /** External identity provider (Clerk): JWKS URL and issuer used to verify session tokens. */
  AUTH_JWKS_URL: z.string().url().optional(),
  AUTH_ISSUER: z.string().optional(),
  AUTH_AUDIENCE: z.string().optional(),

  /** Trip the read-only demo account can view; enables POST /auth/demo. */
  DEMO_TRIP_ID: z.string().optional(),

  /** Comma-separated origins allowed by CORS. */
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  /** Base URL of the web app, used to build invite links. */
  PUBLIC_WEB_URL: z.string().default("http://localhost:3000"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === "production" && config.AUTH_DEV_LOGIN) {
    throw new Error("AUTH_DEV_LOGIN must be off in production");
  }
  if (config.AUTH_JWKS_URL && !config.AUTH_ISSUER) {
    throw new Error("AUTH_ISSUER is required when AUTH_JWKS_URL is set");
  }
  return config;
}
