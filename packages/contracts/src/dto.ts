import type { ArriveMode, Budget, Check, CheckLevel, EventCheck, PlaceStatus, VisaRule, VisaSummary, When } from "@trippr/rules";
import type { BestTime, GoodFor, PriceLevel } from "./catalogue";
import type { Leg, StopStay } from "./explorer";
import type { Role } from "./schemas";

/** Every error response uses this one shape. */
export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "version_conflict"
  | "invite_expired"
  | "unavailable"
  | "rate_limited"
  | "internal";

export interface Me {
  id: string;
  name: string;
  email?: string | null;
  isDemo?: boolean;
}

export interface AuthToken {
  token: string;
  user: Me;
}

export interface TripRef {
  id: string;
  name: string;
  startDate: string;
  homeCity?: string | null;
  /** Number of people travelling; 1 when not set. */
  travellers?: number | null;
  /** The latest the group can be home (trip setup's date range); routes ending later get a check. */
  latestReturn?: string | null;
  /** The group's budget per person in CAD; routes over it get ways back under. */
  budgetPerPerson?: number | null;
}

export interface TripListItem extends TripRef {
  role: Role;
  routeCount: number;
}

export interface Member {
  id: string;
  name: string;
  role: Role;
}

export interface RouteRef {
  id: string;
  name: string;
  tags: string[];
  isCurrent: boolean;
  version: number;
  createdAt: string;
  derivedFrom?: { id: string; name: string } | null;
}

export interface RouteSummary extends RouteRef {
  stopCount: number;
  totalNights: number;
  returnDate: string;
  checksLevel: CheckLevel;
  cities: string[];
  /** Estimated cost per person in CAD (stay + travel + planned activities). */
  perPersonCad: number;
}

export interface TripDetail {
  trip: TripRef;
  role: Role;
  members: Member[];
  routes: RouteSummary[];
}

export interface Invite {
  token: string;
  role: Role;
  expiresAt: string;
  url: string;
}

export interface InvitePreview {
  trip: TripRef;
  role: Role;
  expiresAt: string;
  expired: boolean;
}

export interface Country {
  iso: string;
  name: string;
  visaRule?: VisaRule | null;
  /** Colour used for this country on the timeline. */
  color?: string | null;
}

export interface City {
  code: string;
  name: string;
  lat: number;
  lon: number;
  countryIso: string;
  countryName: string;
  /** IANA time zone, e.g. "Asia/Tokyo". */
  tz?: string | null;
}

export interface ActivityRef {
  id: string;
  title: string;
  when?: When | null;
  costCad?: number | null;
  /** Planned day within the stop, 1 = the arrival day. */
  day?: number | null;
  /** Local start time at the stop, "HH:MM". */
  startTime?: string | null;
  durationMin?: number | null;
}

export interface Activity extends ActivityRef {
  /** Text to search on Google Maps for this place, when it differs from the title. */
  mapsQuery?: string | null;
  /** Where the idea came from: a video, an article, a booking page. */
  url?: string | null;
  tags: string[];
  cityCode: string;
  cityName: string;
  countryIso?: string | null;
  /** The place's own site, its ticket page and its reservation page. */
  website?: string | null;
  ticketUrl?: string | null;
  reserveUrl?: string | null;
  /** A Google Maps link someone shared for this place. */
  mapsUrl?: string | null;
  /** The pin, once the lookup or a person has placed it (OpenStreetMap or by hand). */
  lat?: number | null;
  lon?: number | null;
  address?: string | null;
  placeStatus?: PlaceStatus;
  votes: number;
  /** How many members said yes and no. Counts only: who voted what is never shared. */
  ups?: number;
  downs?: number;
  myVote: -1 | 0 | 1;
  commentCount: number;
  /** True for places loaded from the data pipeline's catalogue rather than written by the group. */
  catalogue?: boolean;
  /** The catalogue's category (viewpoint, museum, ...). */
  category?: string | null;
  /** Ranking score and rank in the city, 1 = best (catalogue places). */
  score?: number | null;
  rank?: number | null;
  /** False once a newer bundle stopped listing the place: "no longer listed". Planned and voted places stay. */
  listed?: boolean;
  nameLocal?: string | null;
  phone?: string | null;
  openingHours?: string | null;
  /** Where a catalogue place comes from: each source record with its licence. */
  sources?: ActivitySource[];
  /** What the LLM enrichment stage added; absent on hand-written activities and places it has not covered. */
  enrichment?: ActivityEnrichment;
}

/** AI-written fields of a catalogue place (pipelines enrich stage). Every field may be null: the model says nothing it cannot support. */
export interface ActivityEnrichment {
  /** Taxonomy categories the model chose (museum, viewpoint, ...). Not the colour tags in `tags`. */
  tags: string[];
  /** One line; null when there is none. Shown with `aiLabel`. */
  summary: string | null;
  /** True when `summary` was written by a model: the app must say so. */
  summaryAi: boolean;
  /** The sentence to show beside the summary, e.g. "Summary written by AI from Wikidata and Wikivoyage". */
  aiLabel: string | null;
  /** Typical visit, in minutes. */
  durationMin: number | null;
  bestTime: BestTime | null;
  indoor: boolean | null;
  priceLevel: PriceLevel | null;
  goodFor: GoodFor[];
  /** A suggested readable name. Only ever a subtitle, and only when `isGenericName`; never the title. */
  displayName: string | null;
  isGenericName: boolean;
  model: string | null;
  enrichedAt: string | null;
}

export interface ActivitySource {
  /** Source id from the registry, e.g. "overture". */
  source: string;
  /** The record's id in that source. */
  sourceId: string;
  licence: string;
}

export interface LibraryActivity extends Activity {
  /** Routes in this trip whose stops plan this activity. */
  plannedIn: { routeId: string; routeName: string; stopId: string }[];
}

/** What "Find on map" did. */
export interface PlaceLookupResult {
  activity: LibraryActivity;
  outcome: "placed" | "check" | "not_found" | "skipped";
}

export interface StopActivity extends Activity {
  planned: boolean;
}

export interface StopView {
  id: string;
  order: number;
  nights: number;
  arriveMode: ArriveMode;
  arriveNote?: string | null;
  notes?: string | null;
  /** Accommodation per person per night in CAD, when estimated. */
  stayCadPerNight?: number | null;
  /** Per-person cost of getting here in CAD, when estimated. */
  arriveCostCad?: number | null;
  arrive: string;
  depart: string;
  city: City;
  country: Country;
  planned: ActivityRef[];
  /** How this stop is reached: chained ticket segments between hubs, in order. */
  legs: Leg[];
  /** Hotels shortlisted, chosen or booked for this stop. */
  stays: StopStay[];
}

export interface RouteChecks {
  level: CheckLevel;
  totalNights: number;
  returnDate: string;
  checks: Check[];
  visa: VisaSummary[];
  events: EventCheck[];
}

export interface RouteView {
  route: RouteRef & { tripId: string };
  trip: TripRef;
  role: Role;
  stops: StopView[];
  /** Tickets home after the last stop. A booked one fixes the home date. */
  homeLegs: Leg[];
  checks: RouteChecks;
  /** Kept for compatibility: the planned-activities part of the budget, per person. */
  plannedCostCad: number;
  budget: Budget;
}

export interface StopLibrary {
  stopId: string;
  cityCode: string;
  activities: StopActivity[];
}

export interface Comment {
  id: string;
  text: string;
  at: string;
  author: { id: string; name: string };
}

export interface CompareResult {
  a: RouteSummary;
  b: RouteSummary;
  shared: string[];
  onlyA: string[];
  onlyB: string[];
  nightsByCountry: { country: string; iso: string; a: number; b: number }[];
  /** Planned in B but not in A. */
  activitiesGained: ActivityRef[];
  /** Planned in A but not in B. */
  activitiesLost: ActivityRef[];
  budget: { a: Budget; b: Budget };
}

export interface PathLeg {
  from: string;
  to: string;
  mode: string;
  minutes?: number | null;
  costCad?: number | null;
  source?: string | null;
  asOf?: string | null;
}

export interface PathResult {
  found: boolean;
  by: "hops" | "minutes" | "costCad";
  railOnly: boolean;
  cities: City[];
  legs: PathLeg[];
  totalMinutes: number | null;
  totalCostCad: number | null;
}

export interface Health {
  ok: boolean;
  db: "up" | "down";
  dialect: string;
}
