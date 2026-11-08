/**
 * pnpm db:seed [--force-routes]
 *
 * Loads the real Asia 2027 trip from seed/*.json. Safe to re-run: reference
 * data is refreshed, the trip and its routes are only created once.
 */
import { createGraphClient, dbConfigFromEnv } from "@trippr/api/db";
import { seedDatabase } from "@trippr/api/seed";
import { resolve } from "node:path";

const db = await createGraphClient(dbConfigFromEnv());
try {
  const result = await seedDatabase(db, {
    seedDir: resolve(import.meta.dirname, "../seed"),
    forceRoutes: process.argv.includes("--force-routes"),
    ownerInviteToken: process.env.SEED_OWNER_INVITE,
  });
  const { counts } = result;
  console.log(
    `Seeded ${counts.countries} countries, ${counts.cities} cities, ${counts.activities} activities, ${counts.links} links.`,
  );
  console.log(
    result.routesSeeded.length
      ? `Trip ${result.tripId}: routes ${result.routesSeeded.join(", ")}.`
      : `Trip ${result.tripId} already existed; routes left as they are (use --force-routes to re-create them).`,
  );
  if (result.ownerInvite) {
    const web = process.env.PUBLIC_WEB_URL ?? "http://localhost:3000";
    console.log(`\nClaim ownership of the trip (expires ${result.ownerInvite.expiresAt}):`);
    console.log(`  ${web}/invite/${result.ownerInvite.token}\n`);
  }
} finally {
  await db.close();
}
