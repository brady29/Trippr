import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke tests against a real API and a throwaway graph (trippr_e2e), which
 * is reset, re-seeded with the real trip and loaded with a small catalogue bundle every run.
 */
const API_PORT = 8081;
const WEB_PORT = 3100;
export const E2E_API_URL = `http://localhost:${API_PORT}`;
export const E2E_OWNER_INVITE = "e2e-owner-invite-token";
/** The data pipeline's golden bundle (Tokyo and Osaka places), put in the graph by the real load job. */
export const E2E_BUNDLES = fileURLToPath(new URL("../../pipelines/tests/fixtures/expected/bundle", import.meta.url));

const apiEnv = {
  NODE_ENV: "test",
  PORT: String(API_PORT),
  FALKORDB_URL: process.env.FALKORDB_URL ?? "redis://localhost:6379",
  FALKORDB_GRAPH: "trippr_e2e",
  APP_JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123",
  AUTH_DEV_LOGIN: "true",
  DEMO_TRIP_ID: "asia-2027",
  WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
  PUBLIC_WEB_URL: `http://localhost:${WEB_PORT}`,
  SEED_OWNER_INVITE: E2E_OWNER_INVITE,
  LOG_LEVEL: "warn",
  INBOX_LINK_PREVIEWS: "false",
  INBOX_LOOKUP: "off",
  GEOCODER: "none",
  // Never call Claude from end-to-end runs; the Ask panel shows its "off" state.
  ASSISTANT_ENABLED: "false",
  // Flight prices run on invented sample history (see flight-prices.spec.ts); no provider key is ever used.
  FLIGHT_PRICES_ENABLED: "true",
  FLIGHT_PRICES_PROVIDER: "demo",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // No retries: the suite runs in serial against one database, so a retry would
  // replay steps on data the first attempt already changed.
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] }, grep: /@phone/ },
  ],
  webServer: [
    {
      command: `pnpm --dir ../.. db:reset && pnpm --dir ../.. db:load-bundle --bundle "${E2E_BUNDLES}" && pnpm --dir ../api exec tsx src/flight-snapshots.ts --demo-seed && pnpm --dir ../api exec tsx src/server.ts`,
      url: `${E2E_API_URL}/health`,
      env: apiEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: process.env.CI ? `pnpm build && pnpm exec next start --port ${WEB_PORT}` : `pnpm exec next dev --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      env: { NEXT_PUBLIC_API_URL: E2E_API_URL, NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-e2e" },
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
});
