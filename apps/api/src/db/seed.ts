import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cypher } from "../repositories/queries";
import type { GraphClient } from "./graph";

interface SeedCountry {
  iso: string;
  name: string;
  color?: string;
  visaRule?: unknown;
}
interface SeedCity {
  code: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  kind?: string;
}
interface SeedActivity {
  id: string;
  city: string;
  title: string;
  tags?: string[];
  when?: unknown;
  url?: string;
  costCad?: number;
}
interface SeedLink {
  from: string;
  to: string;
  mode: string;
  minutes?: number;
  costCad?: number;
  note?: string;
  source?: string;
  asOf?: string;
  bothWays?: boolean;
}
interface SeedStop {
  city: string;
  nights: number;
  arriveMode?: string;
  arriveNote?: string;
  notes?: string;
  plans?: string[];
}
interface SeedRoute {
  id: string;
  name: string;
  tags?: string[];
  isCurrent?: boolean;
  stops: SeedStop[];
}
interface SeedTrip {
  id: string;
  name: string;
  startDate: string;
  homeCity?: string;
  travellers?: number;
  routes: string[];
}

export interface SeedOptions {
  seedDir: string;
  /** Re-create seeded routes even when the trip already exists. */
  forceRoutes?: boolean;
  /** Token for the one-time owner invite; random when omitted. */
  ownerInviteToken?: string;
  now?: () => string;
}

export interface SeedResult {
  tripId: string;
  tripCreated: boolean;
  routesSeeded: string[];
  counts: { countries: number; cities: number; activities: number; links: number };
  ownerInvite?: { token: string; expiresAt: string };
}

const readJson = <T>(dir: string, file: string): T => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
const json = (value: unknown) => (value == null ? null : JSON.stringify(value));

/**
 * Load the real trip from seed/*.json with idempotent MERGE statements.
 * Reference data (countries, cities, activities, links) is refreshed on every
 * run; the trip and its routes are only created once, so re-running the seed
 * never overwrites what the group has edited.
 */
export async function seedDatabase(db: GraphClient, options: SeedOptions): Promise<SeedResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const q = (name: string) => cypher(`seed/${name}`, db.dialect);
  const dir = options.seedDir;

  const countries = readJson<SeedCountry[]>(dir, "countries.json");
  const cities = readJson<SeedCity[]>(dir, "cities.json");
  const activities = readJson<SeedActivity[]>(dir, "activities.json");
  const { links } = readJson<{ links: SeedLink[] }>(dir, "links.json");
  const trip = readJson<SeedTrip>(dir, "trip.json");

  await db.query(q("country"), {
    countries: countries.map((c) => ({ iso: c.iso, name: c.name, color: c.color ?? null, visaRule: json(c.visaRule) })),
  });
  await db.query(q("city"), {
    cities: cities.map((c) => ({ ...c, kind: c.kind ?? "city" })),
  });
  const edges = links.flatMap((l) => {
    const edge = {
      from: l.from,
      to: l.to,
      mode: l.mode,
      minutes: l.minutes ?? null,
      costCad: l.costCad ?? null,
      note: l.note ?? null,
      source: l.source ?? null,
      asOf: l.asOf ?? null,
    };
    return l.bothWays ? [edge, { ...edge, from: l.to, to: l.from }] : [edge];
  });
  await db.query(q("link"), { links: edges });

  const stamp = now();
  const [tripRow] = await db.query<{ created: boolean }>(q("trip"), {
    id: trip.id,
    name: trip.name,
    startDate: trip.startDate,
    homeCity: trip.homeCity ?? null,
    travellers: trip.travellers ?? 1,
    now: stamp,
  });
  const tripCreated = Boolean(tripRow?.created);

  await db.query(q("activity"), {
    tripId: trip.id,
    activities: activities.map((a) => ({
      id: a.id,
      city: a.city,
      title: a.title,
      tags: a.tags ?? [],
      when: json(a.when),
      url: a.url ?? null,
      costCad: a.costCad ?? null,
    })),
  });

  const routesSeeded: string[] = [];
  if (tripCreated || options.forceRoutes) {
    for (const file of trip.routes) {
      const route = readJson<SeedRoute>(dir, file);
      const shortId = route.id.replace(/^route-/, "");
      await db.query(q("route"), {
        tripId: trip.id,
        id: route.id,
        name: route.name,
        tags: route.tags ?? [],
        isCurrent: route.isCurrent ?? false,
        now: stamp,
        stops: route.stops.map((s, i) => ({
          id: `stop-${shortId}-${String(i + 1).padStart(2, "0")}`,
          order: i,
          city: s.city,
          nights: s.nights,
          arriveMode: s.arriveMode ?? "flight",
          arriveNote: s.arriveNote ?? null,
          notes: s.notes ?? null,
          plans: s.plans ?? [],
        })),
      });
      routesSeeded.push(route.id);
    }
  }

  const expiresAt = new Date(Date.parse(stamp) + 30 * 86_400_000).toISOString();
  const [invite] = await db.query<{ token: string; expiresAt: string }>(q("owner-invite"), {
    tripId: trip.id,
    token: options.ownerInviteToken ?? randomBytes(18).toString("base64url"),
    now: stamp,
    expiresAt,
  });

  return {
    tripId: trip.id,
    tripCreated,
    routesSeeded,
    counts: { countries: countries.length, cities: cities.length, activities: activities.length, links: edges.length },
    ...(invite ? { ownerInvite: invite } : {}),
  };
}
