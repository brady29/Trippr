import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, nowIso } from "../ids";
import { cypher } from "../repositories/queries";
import type { GraphClient } from "./graph";

/** Version marker for the Trip Graph Explorer data migration. */
export const EXPLORER_MIGRATION_ID = "2026-11-graph-explorer";

/** Cities that are really hubs; their City nodes are removed once nothing stops there. */
const RETIRED_CITY_CODES = ["PVG", "LYD"];

export interface HubSeed {
  hubId: string;
  kind: "station" | "airport";
  code?: string | null;
  name: string;
  nameLocal?: string | null;
  stationKind?: string | null;
  lat: number;
  lon: number;
  cityCode: string;
  cityName: string;
  serves: string[];
  source?: string;
}

interface LinkSeed {
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

export interface HubsFile {
  asOf: string;
  hubs: HubSeed[];
  home: string;
  /** City code → mode → default hub id. */
  defaults: Record<string, Partial<Record<string, string>>>;
  links: LinkSeed[];
}

interface AreaSeed {
  id: string;
  city: string;
  name: string;
  vibes: string[];
  lat: number | null;
  lon: number | null;
  note?: string;
  /** How far the Area reaches from its centre (default 1.5 km); the stay analytics use it too. */
  radiusKm?: number;
}

const readJson = <T>(dir: string, file: string): T => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;

/**
 * The hub a leg uses into or out of a city for a mode. Rail modes fall back
 * to each other (a "train" into a city with only a high-speed station uses it).
 */
export function defaultHub(defaults: HubsFile["defaults"], cityCode: string, mode: string): string | undefined {
  const forCity = defaults[cityCode];
  if (!forCity) return undefined;
  const fallbacks: Record<string, string[]> = {
    flight: ["flight"],
    hsr: ["hsr", "train"],
    train: ["train", "hsr"],
    maglev: ["maglev", "train", "hsr"],
    boat: ["boat"],
    road: ["road"],
  };
  for (const m of fallbacks[mode] ?? [mode]) if (forCity[m]) return forCity[m];
  return undefined;
}

export interface PlannedLegRow {
  id: string;
  stopId: string;
  seq: number;
  mode: string;
  status: "idea";
  from: string;
  to: string;
  source: string;
  asOf: string;
}

/**
 * One idea leg for each stop that has none yet, from the previous stop's
 * hub to this city's hub for the stop's arrival mode. The first stop of a
 * route departs from home (by air only). Stops whose cities have no hub for
 * that mode (a boat to Komodo) get no leg.
 */
export function planLegs(
  stops: { routeId: string; stopId: string; arriveMode: string | null; cityCode: string; legs: number }[],
  hubs: Pick<HubsFile, "defaults" | "home">,
  asOf: string,
): PlannedLegRow[] {
  const legs: PlannedLegRow[] = [];
  let routeId: string | null = null;
  let prevCity: string | null = null;
  for (const s of stops) {
    if (s.routeId !== routeId) {
      routeId = s.routeId;
      prevCity = null;
    }
    const mode = s.arriveMode ?? "flight";
    if (s.legs === 0) {
      const to = defaultHub(hubs.defaults, s.cityCode, mode);
      const from = prevCity === null ? (mode === "flight" ? hubs.home : undefined) : defaultHub(hubs.defaults, prevCity, mode);
      if (from && to && from !== to) {
        legs.push({
          id: newId("lg"),
          stopId: s.stopId,
          seq: 0,
          mode,
          status: "idea",
          from,
          to,
          source: "migrated from the stop's travel mode",
          asOf,
        });
      }
    }
    prevCity = s.cityCode;
  }
  return legs;
}

/** City-level LINK edges copied to the default hubs at both ends, plus explicit hub links. */
export function planHubLinks(cityLinks: LinkSeed[], hubs: HubsFile) {
  const expand = (links: LinkSeed[]) =>
    links.flatMap((l) => (l.bothWays ? [l, { ...l, from: l.to, to: l.from }] : [l]));
  const rows = new Map<string, Record<string, unknown>>();
  const add = (from: string, to: string, l: LinkSeed) => {
    if (from === to) return;
    rows.set(`${from}|${to}|${l.mode}`, {
      from,
      to,
      mode: l.mode,
      minutes: l.minutes ?? null,
      costCad: l.costCad ?? null,
      note: l.note ?? null,
      source: l.source ?? null,
      asOf: l.asOf ?? hubs.asOf,
    });
  };
  for (const l of expand(cityLinks)) {
    const from = defaultHub(hubs.defaults, l.from, l.mode);
    const to = defaultHub(hubs.defaults, l.to, l.mode);
    if (from && to) add(from, to, l);
  }
  for (const l of expand(hubs.links)) add(l.from, l.to, l);
  return [...rows.values()];
}

export interface ExplorerMigrationResult {
  ran: boolean;
  hubs: number;
  hubLinks: number;
  areas: number;
  legsCreated: number;
}

/**
 * Brings an existing Trippr graph up to the Trip Graph Explorer model.
 * Reference data (hubs and hub links) is refreshed on every run; the
 * one-time steps (suggested areas, idea legs for stops without any, retiring
 * the old Pudong/Longyang Road city nodes) run once, behind a Migration
 * marker, so a leg someone deleted on purpose never comes back. `force`
 * re-runs the one-time steps (tests use it to prove they are idempotent).
 */
/** Second batch of suggested areas, added with the 50+ city sample-data expansion. */
const AREAS_EXPANSION_ID = "graph-explorer-areas-2026-11-19";

export async function migrateGraphExplorer(
  db: GraphClient,
  options: { seedDir: string; force?: boolean; now?: string },
): Promise<ExplorerMigrationResult> {
  const q = (name: string) => cypher(`explorer/${name}`, db.dialect);
  const now = options.now ?? nowIso();
  const hubs = readJson<HubsFile>(options.seedDir, "hubs.json");
  const { links: cityLinks } = readJson<{ links: LinkSeed[] }>(options.seedDir, "links.json");
  const trip = readJson<{ id: string }>(options.seedDir, "trip.json");
  const areas = readJson<{ source: string; areas: AreaSeed[] }>(options.seedDir, "areas.json");

  await db.query(q("hubs-upsert"), {
    hubs: hubs.hubs.map((h) => ({
      hubId: h.hubId,
      kind: h.kind,
      code: h.code ?? null,
      name: h.name,
      nameLocal: h.nameLocal ?? null,
      stationKind: h.stationKind ?? null,
      lat: h.lat,
      lon: h.lon,
      cityCode: h.cityCode,
      cityName: h.cityName,
      source: h.source ?? null,
      asOf: hubs.asOf,
    })),
  });
  await db.query(q("hubs-serve"), {
    serves: hubs.hubs.flatMap((h) => h.serves.map((cityCode) => ({ hubId: h.hubId, cityCode }))),
  });
  const hubLinks = planHubLinks(cityLinks, hubs);
  const seedAreas = () =>
    db.query(q("areas-seed"), {
      tripId: trip.id,
      now,
      areas: areas.areas.map((a) => ({
        id: a.id,
        city: a.city,
        name: a.name,
        vibes: a.vibes,
        lat: a.lat,
        lon: a.lon,
        note: a.note ?? null,
        radiusKm: a.radiusKm ?? 1.5,
        source: areas.source,
      })),
    });
  const createLegs = (rows: PlannedLegRow[]) =>
    db.query(q("legs-create"), {
      legs: rows.map((l) => ({
        ...l,
        createdAt: now,
        operator: null,
        number: null,
        departAt: null,
        arriveAt: null,
        durationMin: null,
        priceCad: null,
        bookingRef: null,
        seat: null,
      })),
    });
  await db.query(q("hub-links"), { links: hubLinks });

  // Every run: sample routes added to an existing trip get their idea legs now that the hubs exist.
  const flagged = await db.query<{ routeId: string; stopId: string; arriveMode: string | null; cityCode: string; legs: number }>(
    q("flagged-route-stops"),
  );
  const flaggedLegs = planLegs(flagged.map((s) => ({ ...s, legs: Number(s.legs) })), hubs, now.slice(0, 10));
  if (flaggedLegs.length) await createLegs(flaggedLegs);
  if (flagged.length) await db.query(q("flagged-routes-clear"));

  // Once more after the sample-data expansion: areas the trip doesn't have yet (existing ones are left as they are).
  const [areasMarker] = await db.query<{ id: string }>(q("marker-get"), { id: AREAS_EXPANSION_ID });
  if (!areasMarker) {
    await seedAreas();
    await db.query(q("marker-set"), { id: AREAS_EXPANSION_ID, now });
  }

  const base = { ran: false, hubs: hubs.hubs.length, hubLinks: hubLinks.length, areas: 0, legsCreated: flaggedLegs.length };
  const [marker] = await db.query<{ id: string }>(q("marker-get"), { id: EXPLORER_MIGRATION_ID });
  if (marker && !options.force) return base;

  await seedAreas();

  const stops = await db.query<{
    routeId: string;
    stopId: string;
    stopOrder: number;
    arriveMode: string | null;
    cityCode: string;
    legs: number;
  }>(q("route-stops"));
  const legs = planLegs(
    stops.map((s) => ({ ...s, legs: Number(s.legs) })),
    hubs,
    now.slice(0, 10),
  );
  if (legs.length) await createLegs(legs);

  await db.query(q("cities-cleanup"), { codes: RETIRED_CITY_CODES });
  await db.query(q("marker-set"), { id: EXPLORER_MIGRATION_ID, now });
  return { ran: true, hubs: hubs.hubs.length, hubLinks: hubLinks.length, areas: areas.areas.length, legsCreated: legs.length + flaggedLegs.length };
}
