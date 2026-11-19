/**
 * Recommended ways to travel between two places, with door-to-door time and
 * an estimated cost. Stored travel links (real timetable research) win;
 * otherwise each mode is estimated from distance, what each place has
 * (airport, high-speed or regular rail station), whether a road connects them
 * and whether their rail networks join up. Figures are rough planning
 * estimates in CAD, not quotes.
 */
import type { ArriveMode } from "./types";

export type TravelMode = "flight" | "hsr" | "train" | "bus" | "car" | "boat";
export type TravelPriority = "balanced" | "fastest" | "cheapest";

export interface PlaceFacts {
  code: string;
  name: string;
  countryIso: string;
  lat: number;
  lon: number;
  airport: boolean;
  /** A high-speed rail station. */
  hsr: boolean;
  /** Any rail station (high-speed stations count). */
  rail: boolean;
}

export interface KnownLink {
  mode: string;
  minutes?: number | null;
  costCad?: number | null;
  source?: string | null;
  note?: string | null;
}

export interface TravelOption {
  mode: TravelMode;
  label: string;
  /** Door to door, including getting to the airport or station and waiting. */
  minutes: number;
  costPerPersonCad: number;
  /** What the whole group pays (differs from per person × travellers only for cars). */
  groupCostCad: number;
  distanceKm: number;
  source: "stored" | "estimate";
  sourceNote?: string | null;
  note: string;
  /** How the stop's arrival mode should be set if this option is used. */
  arriveMode: ArriveMode;
  score: number;
  recommended: boolean;
}

export const TRAVEL_LABEL: Record<TravelMode, string> = {
  flight: "Fly",
  hsr: "High-speed train",
  train: "Train",
  bus: "Bus",
  car: "Rental car",
  boat: "Boat",
};

/** Value of a traveller's hour, used to balance money against time. */
export const HOUR_VALUE_CAD = 20;

const R_EARTH_KM = 6371;
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Places you can drive or take a bus between. Islands are listed by city
 * code; everything else falls back to a landmass per country.
 */
const ISLAND_BY_CITY: Record<string, string> = {
  OKA: "okinawa",
  CJU: "jeju",
  SYX: "hainan",
  // Philippines: each island on its own.
  MNL: "luzon", ENI: "palawan", PPS: "palawan", USU: "busuanga", CEB: "cebu", TAG: "bohol", MPH: "panay", IAO: "siargao",
  // Indonesia.
  JKT: "java", JOG: "java", SUB: "java", MLG: "java", BDO: "java",
  DPS: "bali", LOP: "lombok", LBJ: "flores", KOM: "komodo", UPG: "sulawesi", SOQ: "papua", KNO: "sumatra",
  // Borneo (Malaysia and Brunei share it).
  BKI: "borneo", KCH: "borneo", BWN: "borneo",
  // Malaysian islands.
  LGK: "langkawi", PEN: "penang",
  // Thai islands.
  USM: "samui", HKT: "phuket",
  PQC: "phuquoc",
};
const LANDMASS_BY_COUNTRY: Record<string, string> = {
  JP: "japan", KR: "korea", TW: "taiwan", LK: "srilanka", MV: "maldives", PH: "luzon", ID: "java",
  CN: "asia", HK: "asia", MO: "asia", MN: "asia", VN: "asia", LA: "asia", KH: "asia", TH: "asia", MY: "asia", SG: "asia", NP: "asia",
  BN: "borneo",
};
export function landmassOf(p: Pick<PlaceFacts, "code" | "countryIso">): string {
  return ISLAND_BY_CITY[p.code] ?? LANDMASS_BY_COUNTRY[p.countryIso] ?? `${p.countryIso}-${p.code}`;
}

/** Rail networks that actually connect across borders (China–Laos railway, Thailand–Malaysia–Singapore). */
const RAIL_NETWORK: Record<string, string> = {
  JP: "jp", KR: "kr", TW: "tw", CN: "cn", HK: "cn", LA: "cn", VN: "vn", TH: "sea", MY: "sea", SG: "sea", KH: "sea", ID: "id",
};
export function railConnected(a: PlaceFacts, b: PlaceFacts): boolean {
  const na = RAIL_NETWORK[a.countryIso];
  if (!na || na !== RAIL_NETWORK[b.countryIso]) return false;
  // Indonesian rail only runs on Java (and Sumatra separately).
  if (na === "id") return landmassOf(a) === landmassOf(b);
  // Penang Island and Langkawi have no trains of their own.
  return landmassOf(a) === landmassOf(b) || (landmassOf(a) === "asia" && landmassOf(b) === "asia");
}

const round5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);
const roundMin = (n: number) => Math.round(n / 5) * 5;

function estimate(mode: TravelMode, km: number, a: PlaceFacts, b: PlaceFacts, travellers: number) {
  const roadKm = km * 1.3;
  switch (mode) {
    case "flight": {
      // About 2.5 h of airport time (getting there, security, boarding, bags) plus the flight.
      const minutes = 150 + 25 + (km / 750) * 60;
      const cost = 50 + km * 0.11;
      return { minutes, cost, group: cost * travellers, note: `About ${Math.max(1, Math.round((km / 750) * 10) / 10)} h in the air; door to door includes about 2.5 h at airports.` };
    }
    case "hsr": {
      const minutes = 50 + ((km * 1.15) / 220) * 60;
      const cost = 5 + km * 0.14;
      return { minutes, cost, group: cost * travellers, note: "City-centre stations; allow about 50 min to get to the station and board." };
    }
    case "train": {
      const minutes = 45 + ((km * 1.2) / 75) * 60;
      const cost = 3 + km * 0.06;
      const overnight = minutes > 8 * 60 ? " Overnight sleeper trains can save a hotel night." : "";
      return { minutes, cost, group: cost * travellers, note: `Regular or sleeper train.${overnight}` };
    }
    case "bus": {
      const minutes = 30 + (roadKm / 55) * 60;
      const cost = Math.max(8, roadKm * 0.05);
      return { minutes, cost, group: cost * travellers, note: `About ${Math.round(roadKm)} km by road.` };
    }
    case "car": {
      const hours = roadKm / 70;
      const minutes = 30 + hours * 60;
      const cars = Math.max(1, Math.ceil(travellers / 5));
      const days = Math.max(1, Math.ceil(hours / 8));
      // Daily rental, fuel and tolls, and a one-way drop-off fee on longer trips.
      const perCar = days * 70 + roadKm * 0.14 + (roadKm > 150 ? 60 : 0);
      const group = cars * perCar;
      return {
        minutes,
        cost: group / Math.max(travellers, 1),
        group,
        note: `${cars} car${cars === 1 ? "" : "s"} for ${travellers}, ${days} day${days === 1 ? "" : "s"}, fuel and a one-way fee included. Check the international driving permit rules for ${a.countryIso === b.countryIso ? a.countryIso : `${a.countryIso} and ${b.countryIso}`}.`,
      };
    }
    case "boat": {
      const minutes = 45 + (km / 30) * 60;
      const cost = 15 + km * 0.15;
      return { minutes, cost, group: cost * travellers, note: "Ferry or boat transfer." };
    }
  }
}

const MODE_FOR_LINK: Record<string, TravelMode> = {
  flight: "flight",
  hsr: "hsr",
  train: "train",
  maglev: "train",
  road: "bus",
  boat: "boat",
};
const ARRIVE_FOR: Record<TravelMode, ArriveMode> = { flight: "flight", hsr: "hsr", train: "train", bus: "road", car: "road", boat: "boat" };

/** Which modes are physically possible between two places. */
export function possibleModes(a: PlaceFacts, b: PlaceFacts, km: number): TravelMode[] {
  const modes: TravelMode[] = [];
  const sameLand = landmassOf(a) === landmassOf(b);
  if (a.airport && b.airport && km >= 150) modes.push("flight");
  if (a.hsr && b.hsr && railConnected(a, b) && km <= 2600) modes.push("hsr");
  if (a.rail && b.rail && railConnected(a, b) && km <= 2000 && !(a.hsr && b.hsr && km < 300)) modes.push("train");
  if (sameLand && km * 1.3 <= 1300) modes.push("bus");
  if (sameLand && km * 1.3 <= 900) modes.push("car");
  return modes;
}

/**
 * Every sensible way from `a` to `b`, best first, with one marked as
 * recommended for the chosen priority.
 */
export function travelOptions(
  a: PlaceFacts,
  b: PlaceFacts,
  known: KnownLink[],
  options: { travellers?: number; priority?: TravelPriority } = {},
): TravelOption[] {
  const travellers = Math.max(1, options.travellers ?? 1);
  const priority = options.priority ?? "balanced";
  const km = distanceKm(a, b);
  const byMode = new Map<TravelMode, TravelOption>();

  for (const mode of possibleModes(a, b, km)) {
    const e = estimate(mode, km, a, b, travellers);
    byMode.set(mode, {
      mode,
      label: TRAVEL_LABEL[mode],
      minutes: roundMin(e.minutes),
      costPerPersonCad: round5(e.cost),
      groupCostCad: round5(e.group),
      distanceKm: Math.round(km),
      source: "estimate",
      note: e.note,
      arriveMode: ARRIVE_FOR[mode],
      score: 0,
      recommended: false,
    });
  }

  // Stored links are real research: they replace the estimate for their mode.
  for (const link of known) {
    const mode = MODE_FOR_LINK[link.mode];
    if (!mode) continue;
    const e = estimate(mode, km, a, b, travellers);
    const overhead = mode === "flight" ? 175 : mode === "hsr" ? 50 : mode === "train" ? 45 : mode === "boat" ? 45 : 30;
    const minutes = link.minutes != null ? link.minutes + overhead : e.minutes;
    const cost = link.costCad != null ? link.costCad : e.cost;
    byMode.set(mode, {
      mode,
      label: TRAVEL_LABEL[mode],
      minutes: roundMin(minutes),
      costPerPersonCad: round5(cost),
      groupCostCad: round5(cost * travellers),
      distanceKm: Math.round(km),
      source: "stored",
      sourceNote: link.source ?? null,
      note: link.note ? `${link.note}${mode === "flight" ? " (plus airport time)" : ""}` : e.note,
      arriveMode: ARRIVE_FOR[mode],
      score: 0,
      recommended: false,
    });
  }

  const list = [...byMode.values()];
  for (const o of list) {
    o.score =
      priority === "fastest"
        ? o.minutes
        : priority === "cheapest"
          ? o.costPerPersonCad
          : o.costPerPersonCad + (o.minutes / 60) * HOUR_VALUE_CAD;
  }
  list.sort((x, y) => x.score - y.score || x.minutes - y.minutes);
  if (list[0]) list[0].recommended = true;
  return list;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}
