import type { FlightDrop, FlightWindowDay } from "@trippr/contracts";
import { addDays, daysBetween, windowDates } from "@trippr/rules";
import type { Config } from "../../config";
import type { GraphClient } from "../../db/graph";
import { createRepositories, type Repositories } from "../../repositories";
import { buildRouteView } from "../route-view";
import { flightHops, hopRouteKey, type FlightHop, type FlightPrices } from "./service";
import { ProviderAuthError, RateLimitedError } from "./provider";

/** Providers cache fares only so far ahead; a flight further out than this is looked at later. */
export const MAX_DAYS_AHEAD = 330;

type Logger = { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void };

export interface SnapshotJobOptions {
  config: Config;
  db: GraphClient;
  flights: FlightPrices;
  /** Today (UTC), YYYY-MM-DD. */
  today: string;
  log?: Logger;
  /** Plan the run and report it without calling the provider or writing anything. */
  dryRun?: boolean;
  /** Take a snapshot even when one already exists for today (it uses the request budget again). */
  force?: boolean;
}

export type SnapshotJobStatus = "disabled" | "not_configured" | "done" | "budget_exhausted" | "rate_limited" | "auth_failed";

export interface SnapshotJobResult {
  status: SnapshotJobStatus;
  /** Flights found on the current routes of all trips (a flight shared by two trips counts once). */
  flights: number;
  /** Snapshots written today. */
  written: number;
  /** Already snapshotted today (the job is idempotent per route and day). */
  skipped: number;
  /** Written, but the provider had no price for the planned date. */
  noPrice: number;
  requests: number;
  /** What a dry run would have asked for. */
  planned: number;
  drops: (FlightDrop & { origin: string; destination: string; departDate: string })[];
  legsUpdated: number;
}

/** The distinct flights on every trip's current route, nearest departure first. */
export async function collectHops(repos: Repositories, today: string): Promise<{ hop: FlightHop; legIds: string[] }[]> {
  const routes = await repos.flights.listRoutes();
  const current = new Map<string, string>();
  // The current route of each trip; a trip with none marked uses its first.
  for (const r of routes) {
    if (r.isCurrent || !current.has(r.tripId)) current.set(r.tripId, r.routeId);
  }
  const byKey = new Map<string, { hop: FlightHop; legIds: string[] }>();
  for (const routeId of current.values()) {
    const stored = await repos.routes.load(routeId);
    if (!stored) continue;
    for (const hop of flightHops(buildRouteView(stored, "viewer"))) {
      if (hop.departDate < today || daysBetween(today, hop.departDate) > MAX_DAYS_AHEAD) continue;
      const key = `${hop.origin}-${hop.destination}-${hop.departDate}`;
      const found = byKey.get(key);
      if (found) found.legIds.push(hop.legId);
      else byKey.set(key, { hop, legIds: [hop.legId] });
    }
  }
  return [...byKey.values()].sort((a, b) => a.hop.departDate.localeCompare(b.hop.departDate) || a.hop.origin.localeCompare(b.hop.origin));
}

/**
 * The daily snapshot. Does nothing until the feature is on and a provider is
 * configured (an API key, or demo mode). For each flight on a current route,
 * asks the provider for the planned date and the days around it, stores one
 * snapshot per route and day (so a re-run costs nothing) and stops when the
 * day's request budget or the provider's rate limit is reached.
 */
export async function runSnapshotJob({ config, db, flights, today, log, dryRun = false, force = false }: SnapshotJobOptions): Promise<SnapshotJobResult> {
  const result: SnapshotJobResult = { status: "done", flights: 0, written: 0, skipped: 0, noPrice: 0, requests: 0, planned: 0, drops: [], legsUpdated: 0 };
  if (!config.FLIGHT_PRICES_ENABLED) return { ...result, status: "disabled" };
  const provider = flights.provider;
  if (!provider) return { ...result, status: "not_configured" };

  const repos = createRepositories(db);
  const hops = await collectHops(repos, today);
  result.flights = hops.length;
  const runId = `${provider.id}:${today}`;
  const used = await repos.flights.requestsToday(runId);
  let remaining = Math.max(0, config.FLIGHT_PRICES_DAILY_BUDGET - used);

  for (const { hop, legIds } of hops) {
    if (!force && (await repos.flights.hasSnapshot(hopRouteKey(provider.id, hop), today))) {
      result.skipped++;
      continue;
    }
    // Days in the window that are still ahead of us.
    const dates = windowDates(hop.departDate, config.FLIGHT_PRICES_WINDOW_DAYS).filter((d) => d >= today);
    if (dryRun) {
      result.planned += dates.length;
      continue;
    }
    if (dates.length > remaining) {
      result.status = "budget_exhausted";
      log?.warn({ remaining, needed: dates.length }, "flight price request budget used up for today");
      break;
    }

    const window: FlightWindowDay[] = [];
    let made = 0;
    let stop: SnapshotJobStatus | null = null;
    try {
      for (const date of dates) {
        made++;
        const quote = await provider.quote({ origin: hop.origin, destination: hop.destination, date, asOf: today });
        window.push({ date, priceCad: quote?.priceCad ?? null, airline: quote?.airline ?? null, stops: quote?.stops ?? null });
      }
    } catch (error) {
      if (error instanceof RateLimitedError) stop = "rate_limited";
      else if (error instanceof ProviderAuthError) stop = "auth_failed";
      else {
        // One flight failing (a timeout, a bad answer) must not stop the others; it is tried again tomorrow.
        log?.warn({ origin: hop.origin, destination: hop.destination, err: error instanceof Error ? error.message : String(error) }, "flight price request failed");
      }
    }
    remaining -= made;
    result.requests += made;
    await repos.flights.addRequests(runId, provider.id, today, made);
    if (stop) {
      result.status = stop;
      log?.warn({ status: stop }, "flight price job stopped");
      break;
    }
    if (window.length < dates.length) continue; // failed part-way: leave no half snapshot

    const { drop } = await flights.recordSnapshot(hop, today, window);
    result.written++;
    const planned = window.find((w) => w.date === hop.departDate);
    if (planned?.priceCad == null) result.noPrice++;
    if (drop) result.drops.push({ ...drop, origin: hop.origin, destination: hop.destination, departDate: hop.departDate });
    // Real prices go on flights still at "idea" (never a booked or hand-typed price). Sample prices never do.
    if (!provider.sample && planned?.priceCad != null) {
      for (const legId of legIds) {
        if (await repos.flights.setLegPrice(legId, planned.priceCad, today, provider.id)) result.legsUpdated++;
      }
    }
  }
  log?.info({ ...result, drops: result.drops.length }, "flight price job finished");
  return result;
}

export interface DemoSeedResult {
  flights: number;
  snapshots: number;
}

/**
 * Sample history for the demo: invented daily snapshots for each flight on a
 * current route, going back `days` days. Only for the demo provider, so real
 * prices and invented ones can never mix.
 */
export async function seedDemoHistory({
  config,
  db,
  flights,
  today,
  days = 45,
}: Pick<SnapshotJobOptions, "config" | "db" | "flights" | "today"> & { days?: number }): Promise<DemoSeedResult> {
  const provider = flights.provider;
  if (!provider?.sample) throw new Error("Demo history needs FLIGHT_PRICES_PROVIDER=demo");
  const repos = createRepositories(db);
  const hops = await collectHops(repos, today);
  let snapshots = 0;
  for (const { hop } of hops) {
    for (let back = days; back >= 0; back--) {
      const asOf = addDays(today, -back);
      if (asOf > hop.departDate) continue;
      const dates = windowDates(hop.departDate, config.FLIGHT_PRICES_WINDOW_DAYS).filter((d) => d >= asOf);
      const window: FlightWindowDay[] = [];
      for (const date of dates) {
        const quote = await provider.quote({ origin: hop.origin, destination: hop.destination, date, asOf });
        window.push({ date, priceCad: quote?.priceCad ?? null, airline: quote?.airline ?? null, stops: quote?.stops ?? null });
      }
      await flights.recordSnapshot(hop, asOf, window);
      snapshots++;
    }
  }
  return { flights: hops.length, snapshots };
}
