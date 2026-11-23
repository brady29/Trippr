import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

/** Empty strings (an unset CI variable) count as "not set". */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

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
  AUTH_JWKS_URL: optional(z.string().url()),
  AUTH_ISSUER: optional(z.string()),
  AUTH_AUDIENCE: optional(z.string()),

  /** Trip the read-only demo account can view; enables POST /auth/demo. */
  DEMO_TRIP_ID: optional(z.string()),

  /** Apply db/schema/<dialect>.cypher on startup (idempotent). */
  DB_AUTO_MIGRATE: bool,
  /** Run the idempotent seed on startup: reference data refreshed, routes only created once. */
  DB_AUTO_SEED: bool,
  /** Folder holding falkordb.cypher / neo4j.cypher; defaults to the repo's db/schema. */
  SCHEMA_DIR: optional(z.string()),
  /** Folder holding the seed JSON; defaults to the repo's seed/. */
  SEED_DIR: optional(z.string()),
  /** Fixed token for the one-time owner invite; random when unset. */
  SEED_OWNER_INVITE: optional(z.string()),

  /** Claude reads inbox emails when set; otherwise only links are recognised. */
  ANTHROPIC_API_KEY: optional(z.string()),
  INBOX_MODEL: z.string().default("claude-opus-5-5"),
  /**
   * Find the place behind each inbox link with Claude's web search and web fetch:
   * website, tickets, reservations and a pin. Defaults to on when ANTHROPIC_API_KEY is set.
   */
  INBOX_LOOKUP: optional(z.enum(["on", "off"])),
  /**
   * The inbound email service's base address, e.g. "abc123@inbound.postmarkapp.com".
   * Each trip gets "abc123+<trip token>@inbound.postmarkapp.com".
   */
  INBOX_EMAIL_ADDRESS: optional(z.string().email()),
  /** Shared secret the inbound email webhook must present. */
  INBOX_WEBHOOK_SECRET: optional(z.string().min(16)),
  /** Look up titles and captions of TikTok and YouTube links (off in tests). */
  INBOX_LINK_PREVIEWS: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),

  /** Trip assistant kill switch. Unset: on when ANTHROPIC_API_KEY is set. */
  ASSISTANT_ENABLED: optional(z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1")),
  ASSISTANT_MODEL: z.string().default("claude-opus-5-5"),
  /** Questions each member can ask per day (UTC), across trips. */
  ASSISTANT_DAILY_LIMIT: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(0).default(30)),

  /** Sentry project DSN; errors are only reported when it is set. */
  SENTRY_DSN: optional(z.string().url()),
  /** Release name sent with errors (the deploy sets the commit SHA). */
  SENTRY_RELEASE: optional(z.string()),

  /** Finds pins for activities: OpenStreetMap's Nominatim, or none (tests, offline). */
  GEOCODER: z.enum(["nominatim", "none"]).default("nominatim"),
  /** Nominatim's usage policy asks for a User-Agent that names the app. */
  GEOCODER_USER_AGENT: z.string().default("Trippr (https://github.com/brady29/Trippr)"),

  /**
   * Flight price history (docs/flight-prices-provider-spike.md). Off by default; when on, the history
   * endpoints answer and the web shows the chart. The daily job is a separate process (flight-snapshots).
   */
  FLIGHT_PRICES_ENABLED: bool,
  /** "travelpayouts" needs TRAVELPAYOUTS_TOKEN; "demo" serves clearly labelled sample data. */
  FLIGHT_PRICES_PROVIDER: z.enum(["travelpayouts", "demo"]).default("travelpayouts"),
  /** Secret: the Travelpayouts Data API token. Read from the environment only. */
  TRAVELPAYOUTS_TOKEN: optional(z.string()),
  /** Most provider requests the job makes per UTC day. */
  FLIGHT_PRICES_DAILY_BUDGET: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(0).default(300)),
  /** Days searched either side of each flight's planned date. */
  FLIGHT_PRICES_WINDOW_DAYS: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(0).max(7).default(3)),
  /** Minimum gap between provider requests, to stay under its rate limit. */
  FLIGHT_PRICES_MIN_INTERVAL_MS: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(0).default(250)),
  /** A snapshot this many percent below the previous low raises a price-drop notice. */
  FLIGHT_PRICES_DROP_PCT: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().min(1).max(90).default(15)),

  /** Comma-separated origins allowed by CORS. */
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  /** Base URL of the web app, used to build invite links. */
  PUBLIC_WEB_URL: z.string().default("http://localhost:3000"),
  /** Public base URL of this API, for calendar feed links; defaults to the address each request came in on. */
  PUBLIC_API_URL: optional(z.string().url()),
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
