/**
 * Trip Graph Explorer contracts: hubs (stations and airports), legs,
 * areas to stay, hotels, and the GraphJSON export that feeds the 2D graph
 * viewer and the 3D globe. See "Trip Graph Explorer Spec".
 */
import { z } from "zod";
import { cityCode, isoDate } from "./schemas";

const id = z.string().min(1).max(80);
const text = (max: number) => z.string().trim().max(max);
const money = z.number().min(0).max(100_000);
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

// --- hubs -----------------------------------------------------------------

export const HUB_KINDS = ["station", "airport"] as const;
export type HubKind = (typeof HUB_KINDS)[number];
export const hubKind = z.enum(HUB_KINDS);

/** A station id ("stn-xian-north") or an airport IATA code ("HKG"). */
export const hubRef = z.object({ kind: hubKind, id: id });
export type HubRef = z.infer<typeof hubRef>;

export interface Hub {
  kind: HubKind;
  /** Station id or airport IATA code. */
  id: string;
  code?: string | null;
  name: string;
  nameLocal?: string | null;
  /** Stations only: hsr, rail, metro, maglev, ferry. */
  stationKind?: string | null;
  lat: number;
  lon: number;
  cityCode: string;
  cityName: string;
}

export const hubSearchQuery = z.object({
  q: z.string().trim().max(60).default(""),
  city: cityCode.optional(),
  kind: hubKind.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

// --- legs -----------------------------------------------------------------

export const LEG_MODES = ["flight", "hsr", "train", "road", "boat", "maglev"] as const;
export type LegMode = (typeof LEG_MODES)[number];
export const LEG_STATUSES = ["idea", "held", "booked"] as const;
export type LegStatus = (typeof LEG_STATUSES)[number];

/** Local ISO 8601 date-time with an offset: 2027-05-19T08:05+08:00. */
export const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/, "Use a date-time with offset, like 2027-05-19T08:05+08:00");

export const createLegBody = z.object({
  mode: z.enum(LEG_MODES),
  from: hubRef,
  to: hubRef,
  operator: text(80).nullish(),
  number: text(40).nullish(),
  departAt: localDateTime.nullish(),
  arriveAt: localDateTime.nullish(),
  durationMin: z.number().int().min(0).max(10_000).nullish(),
  /** Per person, CAD. */
  priceCad: money.nullish(),
  status: z.enum(LEG_STATUSES).default("idea"),
  bookingRef: text(80).nullish(),
  seat: text(40).nullish(),
  /** Position among this stop's chained legs; appended when omitted. */
  seq: z.number().int().min(0).max(20).optional(),
  version: z.number().int().nonnegative(),
});

export const patchLegBody = createLegBody.partial().extend({ version: z.number().int().nonnegative() });

export interface Leg {
  id: string;
  seq: number;
  mode: LegMode;
  from: Hub;
  to: Hub;
  operator?: string | null;
  number?: string | null;
  departAt?: string | null;
  arriveAt?: string | null;
  durationMin?: number | null;
  priceCad?: number | null;
  status: LegStatus;
  source?: string | null;
  asOf?: string | null;
}

/** Editors and the owner only (GET /legs/:id/private). */
export interface LegPrivate {
  id: string;
  bookingRef?: string | null;
  seat?: string | null;
}

// --- areas and hotels -----------------------------------------------------

export const AREA_VIBES = ["food", "nightlife", "quiet", "central", "transit", "beach", "culture", "budget"] as const;
export type AreaVibe = (typeof AREA_VIBES)[number];

export const createAreaBody = z.object({
  tripId: id,
  cityCode,
  name: text(80).min(1),
  lat: lat.nullish(),
  lon: lon.nullish(),
  vibes: z.array(z.enum(AREA_VIBES)).max(8).default([]),
  note: text(500).nullish(),
});
export const patchAreaBody = createAreaBody.omit({ tripId: true, cityCode: true }).partial();

export interface Area {
  id: string;
  name: string;
  lat?: number | null;
  lon?: number | null;
  vibes: AreaVibe[];
  note?: string | null;
  cityCode: string;
  cityName: string;
  votes: number;
  myVote: -1 | 0 | 1;
  hotelCount: number;
}

export const PRICE_BASES = ["room", "person"] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];

export const createHotelBody = z.object({
  tripId: id,
  areaId: id,
  name: text(120).min(1),
  url: z.string().trim().url().max(500).nullish(),
  lat: lat.nullish(),
  lon: lon.nullish(),
  /** CAD per night, per room or per person depending on priceBasis. */
  priceCadPerNight: money.nullish(),
  priceBasis: z.enum(PRICE_BASES).default("room"),
  /** People per room; per-person cost = price / sleeps when priceBasis is "room". */
  sleeps: z.number().int().min(1).max(12).default(2),
  rating: z.number().min(0).max(10).nullish(),
  notes: text(1000).nullish(),
});
export const patchHotelBody = createHotelBody.omit({ tripId: true }).partial();

export interface Hotel {
  id: string;
  name: string;
  url?: string | null;
  lat?: number | null;
  lon?: number | null;
  priceCadPerNight?: number | null;
  priceBasis: PriceBasis;
  sleeps: number;
  rating?: number | null;
  notes?: string | null;
  areaId: string;
  areaName: string;
  cityCode: string;
  cityName: string;
  votes: number;
  myVote: -1 | 0 | 1;
  stays: { stopId: string; routeId: string; routeName: string; status: StayStatus }[];
}

export const STAY_STATUSES = ["shortlist", "chosen", "booked"] as const;
export type StayStatus = (typeof STAY_STATUSES)[number];
export const stayBody = z.object({
  status: z.enum(STAY_STATUSES).default("shortlist"),
  rooms: z.number().int().min(1).max(10).nullish(),
  /** Stays are route-structure writes, guarded by the route version. */
  version: z.number().int().nonnegative(),
});

/** A hotel as it appears on a stop: shortlisted, chosen or booked. */
export interface StopStay {
  status: StayStatus;
  rooms?: number | null;
  hotel: Pick<Hotel, "id" | "name" | "url" | "priceCadPerNight" | "priceBasis" | "sleeps" | "areaId" | "areaName" | "lat" | "lon">;
  /** Per person per night in CAD, after room sharing. */
  perPersonCadPerNight?: number | null;
}

// --- graph export ---------------------------------------------------------

export const GRAPH_NODE_TYPES = [
  "trip",
  "route",
  "stop",
  "city",
  "country",
  "activity",
  "area",
  "hotel",
  "station",
  "airport",
  "leg",
] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

export const GRAPH_EDGE_TYPES = [
  "HAS_ROUTE",
  "HAS_STOP",
  "NEXT",
  "AT",
  "IN",
  "PLANS",
  "STAYS_AT",
  "ARRIVES_VIA",
  "FROM",
  "TO",
  "SERVES",
] as const;
export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number];

const csv = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((v) => v.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(values)).optional());

export const graphQuery = z.object({
  scope: z.enum(["trip", "route", "city"]).default("trip"),
  routeId: id.optional(),
  city: cityCode.optional(),
  types: csv(GRAPH_NODE_TYPES),
});
export type GraphScope = "trip" | "route" | "city";

export interface GraphNode {
  /** Prefixed, stable ids: "city:CKG", "act:act-liziba", "hotel:h_x", "stn:stn-xian-north", "apt:HKG", "leg:lg_x". */
  id: string;
  type: GraphNodeType;
  label: string;
  /** Every placeable node has coordinates; activities and others without them sit near their city. */
  lat?: number;
  lon?: number;
  /** The city a node belongs to, for clustering and placement on the globe. */
  cityCode?: string;
  /** Type-specific fields. Never booking references or seats. */
  attrs: Record<string, unknown>;
  style: {
    /** Activity: primary tag (sport, tech, nature, culture, food) or "other". */
    tag?: string;
    tags?: string[];
    planned?: boolean;
    fixedDate?: boolean;
    votes?: number;
    /** Country colour for cities and countries. */
    color?: string;
    /** Hotel stay status or leg status. */
    status?: string;
    /** Leg mode. */
    mode?: string;
    /** Route ids this node belongs to (for route filtering). */
    routes?: string[];
  };
}

export interface GraphEdge {
  id: string;
  type: GraphEdgeType;
  source: string;
  target: string;
  attrs?: Record<string, unknown>;
}

export interface GraphJSON {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    tripId: string;
    scope: GraphScope;
    routeId?: string | null;
    city?: string | null;
    truncated: boolean;
    counts: Partial<Record<GraphNodeType, number>>;
    generatedAt: string;
    /** Route ids and names, for the filter bar and camera presets. */
    routes: { id: string; name: string; isCurrent: boolean }[];
    tripStart: string;
  };
}

/** Limits from the spec: at most 2,000 nodes and 5,000 edges per response. */
export const GRAPH_LIMITS = { nodes: 2000, edges: 5000 } as const;

export type CreateLegBody = z.input<typeof createLegBody>;
export type PatchLegBody = z.input<typeof patchLegBody>;
export type CreateAreaBody = z.input<typeof createAreaBody>;
export type PatchAreaBody = z.input<typeof patchAreaBody>;
export type CreateHotelBody = z.input<typeof createHotelBody>;
export type PatchHotelBody = z.input<typeof patchHotelBody>;
export type StayBody = z.input<typeof stayBody>;
export type GraphQuery = z.input<typeof graphQuery>;
// Re-exported for convenience in date-only fields used alongside legs.
export { isoDate };

// --- travel options -------------------------------------------------------

export const travelOptionsQuery = z.object({
  from: cityCode,
  to: cityCode,
  travellers: z.coerce.number().int().min(1).max(20).default(1),
  priority: z.enum(["balanced", "fastest", "cheapest"]).default("balanced"),
});
export type TravelOptionsQuery = z.input<typeof travelOptionsQuery>;

export interface TravelOptionsResult {
  from: { code: string; name: string };
  to: { code: string; name: string };
  distanceKm: number;
  priority: "balanced" | "fastest" | "cheapest";
  travellers: number;
  options: import("@trippr/rules").TravelOption[];
}

// --- bookings -------------------------------------------------------------

export const bookingsQuery = z.object({ routeId: id.optional() });

interface BookingBase {
  stopId: string;
  stopOrder: number;
  cityCode: string;
  cityName: string;
  /** YYYY-MM-DD the item happens (departure day for legs, check-in for stays). */
  date: string;
  pricePerPersonCad: number | null;
  /** pricePerPersonCad × travellers. */
  groupCad: number | null;
}

export interface LegBooking extends BookingBase {
  kind: "leg";
  id: string;
  status: LegStatus;
  mode: LegMode;
  from: { id: string; name: string; kind: HubKind };
  to: { id: string; name: string; kind: HubKind };
  operator?: string | null;
  number?: string | null;
  departAt?: string | null;
  arriveAt?: string | null;
  /** Editors and the owner only. */
  bookingRef?: string | null;
  seat?: string | null;
}

export interface StayBooking extends BookingBase {
  kind: "stay";
  id: string;
  status: StayStatus;
  hotelId: string;
  hotelName: string;
  areaName: string;
  url?: string | null;
  checkIn: string;
  checkOut: string;
  nights: number;
  rooms?: number | null;
  perPersonPerNightCad: number | null;
}

export type BookingItem = LegBooking | StayBooking;

export interface BookingsResult {
  trip: { id: string; name: string; travellers: number };
  route: { id: string; name: string; isCurrent: boolean };
  routes: { id: string; name: string; isCurrent: boolean }[];
  canSeePrivate: boolean;
  /** Booked legs and stays, by date. */
  booked: BookingItem[];
  /** Held legs and chosen hotels: picked but not booked yet. */
  pending: BookingItem[];
  /** Stops still missing a booked hotel or booked transport. */
  toBook: {
    stopId: string;
    stopOrder: number;
    cityName: string;
    cityCode: string;
    countryIso: string;
    arrive: string;
    depart: string;
    nights: number;
    needsStay: boolean;
    needsTransport: boolean;
    /** How the stop is reached, and from where (the previous stop, or home for the first). */
    arriveMode: string;
    fromCity: { code: string; name: string; countryIso: string } | null;
  }[];
  totals: { bookedPerPersonCad: number; pendingPerPersonCad: number; bookedGroupCad: number; bookedCount: number; pendingCount: number };
}
