import type { ArriveMode, Budget, Check, CheckLevel, EventCheck, VisaRule, VisaSummary, When } from "@trippr/rules";
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
}

export interface ActivityRef {
  id: string;
  title: string;
  when?: When | null;
  costCad?: number | null;
  day?: number | null;
}

export interface Activity extends ActivityRef {
  url?: string | null;
  tags: string[];
  cityCode: string;
  cityName: string;
  votes: number;
  myVote: -1 | 0 | 1;
  commentCount: number;
}

export interface LibraryActivity extends Activity {
  /** Routes in this trip whose stops plan this activity. */
  plannedIn: { routeId: string; routeName: string; stopId: string }[];
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
