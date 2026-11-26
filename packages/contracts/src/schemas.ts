import { ARRIVE_MODES, isIsoDate, type ArriveMode } from "@trippr/rules";
import { z } from "zod";

export const isoDate = z.string().refine(isIsoDate, { message: "Expected a real date as YYYY-MM-DD" });

export const roleSchema = z.enum(["owner", "editor", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

export const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
export const hasRole = (actual: Role | null | undefined, minimum: Role) =>
  actual != null && ROLE_RANK[actual] >= ROLE_RANK[minimum];

export const arriveModeSchema = z.enum(ARRIVE_MODES as [ArriveMode, ...ArriveMode[]]);

export const whenSchema = z.union([
  z.object({ on: isoDate }).strict(),
  z
    .object({ from: isoDate, to: isoDate })
    .strict()
    .refine((w) => w.from <= w.to, { message: "`from` must be on or before `to`" }),
  z.object({ weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }).strict(),
]);

export const tagName = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(24)
  .regex(/^[a-z0-9][a-z0-9 -]*$/, "Tags use letters, numbers, spaces and dashes");

export const cityCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "City codes are three letters, like CKG");

const id = z.string().min(1).max(64);
const version = z.number().int().nonnegative();
const nights = z.number().int().min(0).max(120);
const shortText = (max: number) => z.string().trim().max(max);

// --- auth -------------------------------------------------------------------

export const devLoginBody = z.object({
  name: shortText(60).min(1),
  email: z.string().trim().email().max(120).optional(),
});

export const updateMeBody = z.object({
  name: shortText(60).min(1).optional(),
  email: z.string().trim().email().max(120).optional(),
});

// --- trips and invites ------------------------------------------------------

/** Something on a fixed date the trip is built around: trip setup turns these into a first route. */
export const mustDoBody = z
  .object({
    cityCode,
    title: shortText(120).min(1),
    from: isoDate,
    to: isoDate,
  })
  .refine((m) => m.from <= m.to, { message: "A must-do ends on or after the day it starts", path: ["to"] });

export const createTripBody = z
  .object({
    name: shortText(80).min(1),
    startDate: isoDate,
    homeCity: shortText(80).optional(),
    travellers: z.number().int().min(1).max(20).optional(),
    /** The latest the group can be home: the end of the date range. */
    latestReturn: isoDate.optional(),
    /** Fixed-date things to build the first route around. */
    mustDos: z.array(mustDoBody).max(12).optional(),
  })
  .refine((t) => !t.latestReturn || t.latestReturn > t.startDate, { message: "The latest return has to be after the start", path: ["latestReturn"] });

export const patchTripBody = z.object({
  name: shortText(80).min(1).optional(),
  startDate: isoDate.optional(),
  homeCity: shortText(80).optional(),
  /** How many people are travelling; drives the group budget. */
  travellers: z.number().int().min(1).max(20).optional(),
  /** The latest the group can be home; null clears it. */
  latestReturn: isoDate.nullable().optional(),
});

export const createInviteBody = z.object({
  role: z.enum(["editor", "viewer"]),
  expiresInDays: z.number().int().min(1).max(90).default(14),
});

// --- routes and stops -------------------------------------------------------

export const createRouteBody = z.object({
  name: shortText(60).min(1).optional(),
  tags: z.array(tagName).max(8).optional(),
  fromRouteId: id.optional(),
});

export const patchRouteBody = z.object({
  name: shortText(60).min(1).optional(),
  tags: z.array(tagName).max(8).optional(),
  isCurrent: z.literal(true).optional(),
  version,
});

export const addStopBody = z.object({
  cityCode,
  nights: nights.default(2),
  /** 0-based insert position; omitted means append. */
  position: z.number().int().min(0).optional(),
  arriveMode: arriveModeSchema.default("flight"),
  /** Other stops' nights to change in the same write: a trade so a booked date stays put. */
  alsoNights: z.array(z.object({ stopId: id, nights })).max(10).optional(),
  version,
});

export const reorderBody = z.object({
  stopIds: z.array(id).min(1).max(100),
  version,
});

/** Several stops' nights in one write, so a trade between two stops saves (and undoes) as one change. */
export const setNightsBody = z.object({
  nights: z.array(z.object({ stopId: id, nights })).min(1).max(100),
  version,
});

export const patchStopBody = z.object({
  nights: nights.optional(),
  arriveMode: arriveModeSchema.optional(),
  arriveNote: shortText(200).optional(),
  notes: shortText(2000).optional(),
  /** Accommodation per person per night in CAD; null clears the estimate. */
  stayCadPerNight: z.number().min(0).max(100_000).nullable().optional(),
  /** Per-person cost of getting to this stop in CAD; null clears the estimate. */
  arriveCostCad: z.number().min(0).max(100_000).nullable().optional(),
  version,
});

export const versionQuery = z.object({ version: z.coerce.number().int().nonnegative() });

// --- activities, votes, comments --------------------------------------------

/** An http(s) link; other schemes (javascript:, data:) are refused. */
export const webLink = z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), { message: "Links must start with http:// or https://" });

export const createActivityBody = z.object({
  tripId: id,
  cityCode,
  title: shortText(120).min(1),
  tags: z.array(tagName).max(8).default([]),
  when: whenSchema.nullish(),
  url: z.string().trim().url().max(500).nullish(),
  costCad: z.number().min(0).max(100_000).nullish(),
  website: webLink.nullish(),
  ticketUrl: webLink.nullish(),
  reserveUrl: webLink.nullish(),
});

export const patchActivityBody = z.object({
  title: shortText(120).min(1).optional(),
  tags: z.array(tagName).max(8).optional(),
  when: whenSchema.nullish(),
  url: z.string().trim().url().max(500).nullish(),
  costCad: z.number().min(0).max(100_000).nullish(),
  website: webLink.nullish(),
  ticketUrl: webLink.nullish(),
  reserveUrl: webLink.nullish(),
});

/**
 * Put an activity's pin somewhere by hand: coordinates, or a Google Maps or
 * Apple Maps link (short share links are followed). clear removes the pin.
 */
export const placeBody = z.union([
  z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict(),
  z.object({ link: z.string().trim().min(3).max(2000) }).strict(),
  z.object({ clear: z.literal(true) }).strict(),
]);

export const planBody = z.object({
  /** Optional 1-based day within the stop. */
  day: z.number().int().min(1).max(120).nullish(),
  /** Local start time at the stop, "HH:MM" (24-hour). */
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 09:30")
    .nullish(),
  /** How long it takes, in minutes. */
  durationMin: z.number().int().min(15).max(720).nullish(),
});

export const voteBody = z.object({
  /** +1 or -1; 0 clears your vote. */
  value: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
});

export const commentBody = z.object({
  text: shortText(280).min(1),
});

export const tripQuery = z.object({ tripId: id });

export const citySearchQuery = z.object({
  q: z.string().trim().max(60).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export const compareQuery = z.object({ a: id, b: id });

export const pathQuery = z.object({
  from: cityCode,
  to: cityCode,
  by: z.enum(["hops", "minutes", "costCad"]).default("minutes"),
  /** Only use rail links; answers "is there a train at all?". */
  railOnly: z.coerce.boolean().default(false),
});

export type CreateTripBody = z.infer<typeof createTripBody>;
export type PatchTripBody = z.infer<typeof patchTripBody>;
export type CreateInviteBody = z.input<typeof createInviteBody>;
export type CreateRouteBody = z.infer<typeof createRouteBody>;
export type PatchRouteBody = z.infer<typeof patchRouteBody>;
export type AddStopBody = z.input<typeof addStopBody>;
export type ReorderBody = z.infer<typeof reorderBody>;
export type PatchStopBody = z.infer<typeof patchStopBody>;
export type SetNightsBody = z.infer<typeof setNightsBody>;
export type CreateActivityBody = z.input<typeof createActivityBody>;
export type PatchActivityBody = z.input<typeof patchActivityBody>;
export type PlaceBody = z.infer<typeof placeBody>;
export type PlanBody = z.input<typeof planBody>;
export type VoteBody = z.infer<typeof voteBody>;
export type CommentBody = z.infer<typeof commentBody>;
export type PathQuery = z.input<typeof pathQuery>;
