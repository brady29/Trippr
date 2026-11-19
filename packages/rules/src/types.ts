/** How a traveller arrives at a stop. */
export type ArriveMode = "flight" | "hsr" | "train" | "road" | "boat";

export const ARRIVE_MODES: readonly ArriveMode[] = ["flight", "hsr", "train", "road", "boat"];

/** Rail modes draw as solid lines on the map; flights are dashed. */
export const RAIL_MODES: readonly ArriveMode[] = ["hsr", "train"];

/** Country-level visa-free rule, stored as JSON on the Country node. */
export interface VisaRule {
  /** Maximum days per entry, counting the arrival and departure days. */
  visaFreeDays: number;
  /** Last date (inclusive) on which an entry qualifies, when the policy has an end date. */
  entriesUntil?: string;
}

/**
 * When an activity can happen, stored as JSON on the Activity node.
 * - `on`: a single fixed date (for example a baseball game)
 * - `from`/`to`: an inclusive date window (for example a tournament)
 * - `weekdays`: recurring days, 0 = Sunday ... 6 = Saturday (Happy Valley races = [3])
 */
export type When = { on: string } | { from: string; to: string } | { weekdays: number[] };

export interface PlannedActivity {
  id: string;
  title: string;
  when?: When | null;
}

/** The minimum a rule needs to know about one stop, in route order. */
export interface RuleStop {
  id: string;
  nights: number;
  cityName: string;
  countryIso: string;
  countryName: string;
  visaRule?: VisaRule | null;
  planned?: PlannedActivity[];
  /** Ticket segments into this stop; departAt is local ISO 8601 with an offset. */
  legs?: { id: string; label?: string; departAt?: string | null }[];
  /** Hotels for this stop; booked ones record the dates they were booked for. */
  stays?: { hotelId: string; name: string; status: string; arrive?: string | null; depart?: string | null }[];
}

export interface ScheduledStop<S extends RuleStop = RuleStop> {
  stop: S;
  /** Arrival date, YYYY-MM-DD. */
  arrive: string;
  /** Departure date, YYYY-MM-DD (arrive + nights). */
  depart: string;
}

export interface Schedule<S extends RuleStop = RuleStop> {
  startDate: string;
  stops: ScheduledStop<S>[];
  totalNights: number;
  returnDate: string;
}

export interface CountryEntry {
  countryIso: string;
  countryName: string;
  stopIds: string[];
  cities: string[];
  arrive: string;
  depart: string;
  nights: number;
  /** Days on the ground for this entry: nights + 1. */
  days: number;
}

export type CheckLevel = "ok" | "info" | "warn" | "error";

export type CheckKind =
  | "total-nights"
  | "return-date"
  | "visa-days"
  | "visa-entries"
  | "visa-policy"
  | "event"
  | "leg-day"
  | "stay-dates";

export interface Check {
  id: string;
  kind: CheckKind;
  level: CheckLevel;
  title: string;
  detail: string;
  stopId?: string;
  activityId?: string;
  legId?: string;
  hotelId?: string;
}

export interface VisaEntry extends CountryEntry {
  overLimit: boolean;
}

export interface VisaSummary {
  countryIso: string;
  countryName: string;
  limitDays: number;
  entriesUntil?: string;
  entries: VisaEntry[];
}

export interface EventCheck {
  stopId: string;
  activityId: string;
  title: string;
  fits: boolean;
  /** Human-readable description of the fixed date(s). */
  whenLabel: string;
  stopArrive: string;
  stopDepart: string;
}

export interface ChecksResult<S extends RuleStop = RuleStop> {
  schedule: Schedule<S>;
  visa: VisaSummary[];
  events: EventCheck[];
  checks: Check[];
  /** Worst level across all checks, for the badge on route cards. */
  level: CheckLevel;
}
