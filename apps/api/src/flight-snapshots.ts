/**
 * The daily flight price snapshot, run as a Cloud Run Job (node dist/flight-snapshots.js)
 * or by hand (pnpm flights:snapshot).
 *
 *   --dry-run     plan the run and print it; no provider calls, nothing written
 *   --force       snapshot again even if today's snapshot exists (uses the budget again)
 *   --demo-seed   write sample history for the demo (needs FLIGHT_PRICES_PROVIDER=demo)
 *   --days N      how many days of sample history (default 45)
 *
 * Does nothing, and exits 0, until FLIGHT_PRICES_ENABLED is on and a provider is
 * set up (TRAVELPAYOUTS_TOKEN, or demo mode). The token is read from the
 * environment only. Exit code 1 means the run failed or stopped early on an
 * auth error, so a scheduler flags it; a rate limit or a used-up budget is
 * normal and exits 0.
 */
import { loadConfig } from "./config";
import { createGraphClient } from "./db";
import { createRepositories } from "./repositories";
import { createDemoProvider } from "./services/flights/demo";
import { runSnapshotJob, seedDemoHistory } from "./services/flights/job";
import { createFlightPrices, resolveProvider } from "./services/flights/service";

const log = {
  info: (obj: unknown, msg?: string) => console.log(JSON.stringify({ level: 30, msg, ...(obj as object) })),
  warn: (obj: unknown, msg?: string) => console.warn(JSON.stringify({ level: 40, msg, ...(obj as object) })),
};

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const daysArg = args.indexOf("--days");

const config = loadConfig();
const today = new Date().toISOString().slice(0, 10);

if (!config.FLIGHT_PRICES_ENABLED) {
  log.info({}, "flight prices are off (FLIGHT_PRICES_ENABLED); nothing to do");
  process.exit(0);
}

if (!resolveProvider(config)) {
  log.info({ provider: config.FLIGHT_PRICES_PROVIDER }, "no flight price provider is set up (TRAVELPAYOUTS_TOKEN is not set); nothing to do");
  process.exit(0);
}

const db = await createGraphClient(config);
let exitCode = 0;
try {
  const repos = createRepositories(db);
  if (flag("--demo-seed")) {
    if (config.FLIGHT_PRICES_PROVIDER !== "demo") throw new Error("--demo-seed needs FLIGHT_PRICES_PROVIDER=demo");
    // About half the routes dip on the last day, so the demo shows a price-drop notice.
    const flights = createFlightPrices({ config, repos, provider: createDemoProvider({ dipDay: today }), today: () => today });
    const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 45;
    log.info(await seedDemoHistory({ config, db, flights, today, days: Number.isFinite(days) ? days : 45 }), "sample flight history written");
  } else {
    const flights = createFlightPrices({ config, repos, today: () => today });
    const result = await runSnapshotJob({ config, db, flights, today, log, dryRun: flag("--dry-run"), force: flag("--force") });
    log.info(result, `flight price job: ${result.status}`);
    if (result.status === "auth_failed") exitCode = 1;
  }
} catch (error) {
  log.warn({ err: error instanceof Error ? error.message : String(error) }, "flight price job failed");
  exitCode = 1;
} finally {
  await db.close();
}
process.exit(exitCode);
