import type Anthropic from "@anthropic-ai/sdk";
import {
  ASSISTANT_MAX_PROPOSALS,
  LEG_MODES,
  PROPOSAL_STALE_MESSAGE,
  type AssistantChange,
  type AssistantProposal,
  type AssistantTurn,
  type FoundPlace,
  type Hub,
  type LegMode,
  type LibraryActivity,
  type RouteView,
} from "@trippr/contracts";
import { addDays, buildItinerary, dayDate, safeWebUrl } from "@trippr/rules";
import { z } from "zod/v4";

/**
 * Suggested changes (editors only), the pure part: the propose_changes tool's
 * schema, checking each suggestion against the route the editor sees, the
 * words on each card, and status bookkeeping on stored turns. Nothing here
 * writes; Apply sends the normal API requests as the editor (see changes.ts).
 */

export const PROPOSE_TOOL_NAME = "propose_changes";

const id = z.string().min(1).max(80);
const code = z.string().regex(/^[A-Za-z]{3}$/, "City codes are three letters, like CKG");
const nights = z.number().int().min(0).max(120);
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/, "Use a local date-time with offset, like 2027-05-19T08:05+08:00");
const end = z
  .object({
    hubId: id.optional().describe("A station id (like stn-xian-north) or an airport's IATA code, from a route's tickets"),
    cityCode: code.optional().describe("Or a city code: its main station, or its airport for flights"),
  })
  .describe("Give hubId or cityCode");

export const proposalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("add_activity"),
      cityCode: code,
      title: z.string().trim().min(1).max(120),
      tags: z.array(z.string().trim().min(1).max(24)).max(8).optional(),
      note: z.string().trim().max(280).optional().describe("Why it's worth doing; added as a comment"),
      url: z.string().trim().max(500).optional().describe("An https link about it, only if the member gave one or web search found it"),
    })
    .describe("A new activity idea in a city's shared library"),
  z
    .object({
      kind: z.literal("plan_activity"),
      stopId: id,
      activityId: id,
      day: z.number().int().min(1).max(120).optional().describe("1-based day within the stop"),
      startTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 09:30")
        .optional()
        .describe("Local start time, HH:MM"),
      durationMin: z.number().int().min(15).max(720).optional(),
    })
    .describe("Plan an existing activity idea at a stop in its city, optionally on a day and time (also moves one already planned)"),
  z.object({ kind: z.literal("set_nights"), stopId: id, nights }).describe("Change how many nights a stop has"),
  z
    .object({
      kind: z.literal("add_stop"),
      cityCode: code,
      afterStopId: id.optional().describe("Insert after this stop; omitted means at the end"),
      nights,
    })
    .describe("Add a city to the route"),
  z
    .object({
      kind: z.literal("add_leg"),
      stopId: id.describe("The stop this travel arrives at"),
      mode: z.enum(LEG_MODES),
      from: end,
      to: end,
      operator: z.string().trim().max(80).optional(),
      number: z.string().trim().max(40).optional(),
      departAt: localDateTime.optional(),
      arriveAt: localDateTime.optional(),
      status: z.literal("idea").optional().describe("Always an idea; members book tickets themselves"),
    })
    .describe("A train, flight or other travel idea (not booked) for getting to a stop"),
]);
export type ProposalInput = z.output<typeof proposalSchema>;
type LegEnd = z.output<typeof end>;

/** The schema the model sees; at runtime each suggestion is checked on its own (see parseProposeInput). */
export const proposeSchema = z.object({
  routeId: id.optional().describe("A route id from the snapshot. Defaults to the current route."),
  proposals: z.array(proposalSchema).min(1).max(ASSISTANT_MAX_PROPOSALS),
});

export const PROPOSE_DESCRIPTION = `Suggest up to ${ASSISTANT_MAX_PROPOSALS} changes to the trip. This changes nothing: each suggestion becomes a card with Apply and Dismiss buttons for the member, and Apply makes the change as them. Kinds: add_activity (a new idea in a city's library), plan_activity (plan an existing idea at a stop, optionally on a day and time), set_nights, add_stop, and add_leg (a travel idea, never booked). Use ids from the snapshot or tool results. Invalid suggestions come back with the reason.`;

export function proposeToolDefinition(): Anthropic.Beta.BetaTool {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(proposeSchema) as Record<string, unknown>;
  return {
    name: PROPOSE_TOOL_NAME,
    description: PROPOSE_DESCRIPTION,
    input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  };
}

export interface Dropped {
  /** 1-based position in the model's list. */
  n: number;
  kind: string | null;
  reason: string;
}

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ");

/**
 * Reads the tool input leniently: each suggestion is validated on its own, so
 * one bad one doesn't sink the rest. Only a missing list is an error.
 * `room` is how many more suggestions this answer may still make.
 */
export function parseProposeInput(
  input: unknown,
  room: number = ASSISTANT_MAX_PROPOSALS,
): { routeId?: string; items: { n: number; proposal: ProposalInput }[]; dropped: Dropped[] } | { error: string } {
  const outer = z.object({ routeId: id.optional(), proposals: z.array(z.unknown()).min(1) }).safeParse(input ?? {});
  if (!outer.success) return { error: `Invalid input for ${PROPOSE_TOOL_NAME}: ${issues(outer.error)}` };
  const items: { n: number; proposal: ProposalInput }[] = [];
  const dropped: Dropped[] = [];
  outer.data.proposals.forEach((raw, i) => {
    const n = i + 1;
    const kind = raw && typeof raw === "object" && typeof (raw as { kind?: unknown }).kind === "string" ? String((raw as { kind: string }).kind).slice(0, 40) : null;
    if (items.length >= room) {
      dropped.push({ n, kind, reason: `That's the limit of ${ASSISTANT_MAX_PROPOSALS} suggestions per answer.` });
      return;
    }
    const parsed = proposalSchema.safeParse(raw);
    if (parsed.success) items.push({ n, proposal: parsed.data });
    else dropped.push({ n, kind, reason: issues(parsed.error) });
  });
  return { routeId: outer.data.routeId, items, dropped };
}

// --- checking against the trip -------------------------------------------------

/** What a suggestion is checked against: the route and library as the editor sees them. */
export interface ProposalFacts {
  view: RouteView;
  activities: Pick<LibraryActivity, "id" | "title" | "cityCode" | "cityName">[];
  /** Known cities by code (upper case). */
  cities: Map<string, { code: string; name: string }>;
  /** Hubs found for leg ends, by hubKey. */
  hubs: Map<string, Hub>;
}

export const hubKind = (mode: LegMode) => (mode === "flight" ? "airport" : "station");
/** How a leg end is looked up: a hub by id, or a city's main station or airport. */
export const hubKey = (side: LegEnd, mode: LegMode) =>
  side.hubId ? `hub:${side.hubId}` : `city:${(side.cityCode ?? "").toUpperCase()}:${hubKind(mode)}`;

export interface CheckedProposal {
  kind: AssistantChange["kind"];
  change: AssistantChange;
  summary: string;
  routeId: string | null;
  version: number | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const TAG = /^[a-z0-9][a-z0-9 -]*$/;

export const MODE_LABEL: Record<LegMode, string> = {
  flight: "flight",
  hsr: "high-speed train",
  train: "train",
  road: "road trip",
  boat: "boat",
  maglev: "maglev",
};

/** "Tue May 12 08:05" from a local date-time with offset. */
const when = (dateTime: string) => `${dayDate(dateTime.slice(0, 10))} ${dateTime.slice(11, 16)}`;

/** The words on a card for planning an activity: "Plan Shibuya Sky on Day 3 (Tue May 11) at 18:30 for 90 min". */
export function describePlan(p: {
  title: string;
  cityName: string;
  moving: boolean;
  dayIndex: number | null;
  date: string | null;
  stopDay?: number;
  startTime?: string;
  durationMin?: number;
}): string {
  const verb = p.moving ? "Move" : "Plan";
  let on: string;
  if (p.stopDay && p.dayIndex != null && p.date) on = ` on Day ${p.dayIndex} (${dayDate(p.date)})`;
  else if (p.stopDay) on = ` on day ${p.stopDay} in ${p.cityName}`;
  else on = ` in ${p.cityName}`;
  const at = p.startTime ? ` at ${p.startTime}` : "";
  const length = p.durationMin ? ` for ${p.durationMin} min` : "";
  return `${verb} ${p.title}${on}${at}${length}`;
}

/** "Tokyo: 4 → 5 nights" */
export const describeNights = (cityName: string, from: number, to: number) => `${cityName}: ${from} → ${plural(to, "night")}`;

export const describeAddStop = (cityName: string, nights: number, afterCity: string | null) =>
  `Add ${cityName} for ${plural(nights, "night")} ${afterCity ? `after ${afterCity}` : "at the end of the route"}`;

export const describeAddActivity = (title: string, cityName: string) => `Add "${title}" to ${cityName}'s ideas`;

export function describeLeg(p: { mode: LegMode; cityName: string; from: string; to: string; number: string | null; departAt: string | null }) {
  const details = [p.number, p.departAt ? when(p.departAt) : null].filter(Boolean).join(", ");
  return `Add a ${MODE_LABEL[p.mode]} idea to ${p.cityName}: ${p.from} → ${p.to}${details ? ` (${details})` : ""}`;
}

/** What the place lookup found, as a second line on the card; null when it found nothing worth showing. */
export function describePlace(place: FoundPlace | null | undefined): string | null {
  if (!place) return null;
  const links = [place.website && "website", place.ticketUrl && "tickets", place.reserveUrl && "reservations", place.eventDate && `date ${dayDate(place.eventDate)}`].filter(
    (x): x is string => Boolean(x),
  );
  const pin =
    place.placeStatus === "placed" ? "pin on the map" : place.placeStatus === "check" ? "a pin to check" : place.placeStatus === "not_found" ? "not found on the map" : null;
  const parts = [links.length ? `Found ${links.join(", ")}` : null, pin ? (links.length ? pin : `${pin[0]!.toUpperCase()}${pin.slice(1)}`) : null].filter(Boolean);
  return parts.length ? `${parts.join("; ")}.` : null;
}

/**
 * Checks one suggestion against the route and library the editor sees.
 * Returns the exact change Apply will send and the words on the card, or the
 * reason it was dropped (which the model reads).
 */
export function checkProposal(p: ProposalInput, facts: ProposalFacts): CheckedProposal | { reason: string } {
  const { view } = facts;
  const routeBound = { routeId: view.route.id, version: view.route.version };
  const stopOf = (stopId: string) => view.stops.find((s) => s.id === stopId);
  const noStop = (stopId: string) => ({ reason: `There is no stop ${stopId} on the route "${view.route.name}" (${view.route.id}).` });
  const city = (cityCode: string) => facts.cities.get(cityCode.toUpperCase());

  switch (p.kind) {
    case "add_activity": {
      const c = city(p.cityCode);
      if (!c) return { reason: `There is no city ${p.cityCode.toUpperCase()}.` };
      const title = p.title.trim();
      const dup = facts.activities.find((a) => a.cityCode === c.code && norm(a.title) === norm(title));
      if (dup) return { reason: `"${dup.title}" is already an idea in ${c.name} (activity id ${dup.id}). Suggest plan_activity to plan it instead.` };
      let url: string | null = null;
      if (p.url) {
        url = safeWebUrl(p.url);
        if (!url) return { reason: "url must be a public https link." };
      }
      const tags = [...new Set((p.tags ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length <= 24 && TAG.test(t)))];
      return {
        kind: p.kind,
        change: { kind: "add_activity", cityCode: c.code, title, tags, note: p.note?.trim() || null, url },
        summary: describeAddActivity(title, c.name),
        // A new idea goes in the city's library, not on a route, so route changes don't affect it.
        routeId: null,
        version: null,
      };
    }

    case "plan_activity": {
      const stop = stopOf(p.stopId);
      if (!stop) return noStop(p.stopId);
      const activity = facts.activities.find((a) => a.id === p.activityId);
      if (!activity) return { reason: `There is no activity ${p.activityId} in this trip.` };
      if (activity.cityCode !== stop.city.code) {
        return { reason: `${activity.title} is in ${activity.cityName}, but stop ${stop.id} is ${stop.city.name}. Plan it at a stop in ${activity.cityName}.` };
      }
      const days = Math.max(stop.nights, 1);
      if (p.day && p.day > days) return { reason: `${stop.city.name} has ${plural(days, "day")} on this route; day must be 1 to ${days}.` };
      const current = stop.planned.find((a) => a.id === activity.id);
      const same =
        current &&
        (p.day === undefined || p.day === current.day) &&
        (p.startTime === undefined || p.startTime === current.startTime) &&
        (p.durationMin === undefined || p.durationMin === current.durationMin);
      if (same) return { reason: `${activity.title} is already planned in ${stop.city.name}${current.day ? ` on day ${current.day}` : ""}${current.startTime ? ` at ${current.startTime}` : ""}.` };
      const date = p.day ? addDays(stop.arrive, p.day - 1) : null;
      const dayIndex = date ? (buildItinerary(view.stops).days.find((d) => d.date === date)?.index ?? null) : null;
      return {
        kind: p.kind,
        change: {
          kind: "plan_activity",
          stopId: stop.id,
          activityId: activity.id,
          ...(p.day !== undefined ? { day: p.day } : {}),
          ...(p.startTime !== undefined ? { startTime: p.startTime } : {}),
          ...(p.durationMin !== undefined ? { durationMin: p.durationMin } : {}),
        },
        summary: describePlan({
          title: activity.title,
          cityName: stop.city.name,
          moving: Boolean(current),
          dayIndex,
          date,
          stopDay: p.day,
          startTime: p.startTime,
          durationMin: p.durationMin,
        }),
        ...routeBound,
      };
    }

    case "set_nights": {
      const stop = stopOf(p.stopId);
      if (!stop) return noStop(p.stopId);
      if (stop.nights === p.nights) return { reason: `${stop.city.name} already has ${plural(p.nights, "night")}.` };
      return {
        kind: p.kind,
        change: { kind: "set_nights", stopId: stop.id, nights: p.nights },
        summary: describeNights(stop.city.name, stop.nights, p.nights),
        ...routeBound,
      };
    }

    case "add_stop": {
      const c = city(p.cityCode);
      if (!c) return { reason: `There is no city ${p.cityCode.toUpperCase()}.` };
      const after = p.afterStopId ? stopOf(p.afterStopId) : null;
      if (p.afterStopId && !after) return noStop(p.afterStopId);
      return {
        kind: p.kind,
        change: { kind: "add_stop", cityCode: c.code, afterStopId: after?.id ?? null, nights: p.nights },
        summary: describeAddStop(c.name, p.nights, after ? after.city.name : null),
        ...routeBound,
      };
    }

    case "add_leg": {
      const stop = stopOf(p.stopId);
      if (!stop) return noStop(p.stopId);
      const hubs: Hub[] = [];
      for (const [side, value] of [
        ["from", p.from],
        ["to", p.to],
      ] as const) {
        if (Boolean(value.hubId) === Boolean(value.cityCode)) return { reason: `${side} needs exactly one of hubId or cityCode.` };
        const hub = facts.hubs.get(hubKey(value, p.mode));
        if (!hub) {
          return {
            reason: value.hubId
              ? `There is no station or airport ${value.hubId}.`
              : `No ${hubKind(p.mode)} is known in ${value.cityCode!.toUpperCase()}; give a hubId instead.`,
          };
        }
        if (p.mode === "flight" ? hub.kind !== "airport" : hub.kind !== "station") {
          return { reason: `${hub.name} is ${hub.kind === "airport" ? "an airport" : "a station"}; a ${MODE_LABEL[p.mode]} needs ${p.mode === "flight" ? "airports" : "stations"}.` };
        }
        hubs.push(hub);
      }
      const [from, to] = hubs as [Hub, Hub];
      if (from.id === to.id) return { reason: "from and to are the same place." };
      const number = p.number?.trim() || null;
      const day = p.departAt?.slice(0, 10);
      if (number && stop.legs.some((l) => l.number === number && (!day || (l.departAt ?? "").startsWith(day)))) {
        return { reason: `${number} is already on the way to ${stop.city.name}.` };
      }
      return {
        kind: p.kind,
        change: {
          kind: "add_leg",
          stopId: stop.id,
          mode: p.mode,
          from: { kind: from.kind, id: from.id },
          to: { kind: to.kind, id: to.id },
          operator: p.operator?.trim() || null,
          number,
          departAt: p.departAt ?? null,
          arriveAt: p.arriveAt ?? null,
          status: "idea",
        },
        summary: describeLeg({ mode: p.mode, cityName: stop.city.name, from: from.name, to: to.name, number, departAt: p.departAt ?? null }),
        ...routeBound,
      };
    }
  }
}

// --- stored proposals ------------------------------------------------------------

export function findProposal(turns: AssistantTurn[], proposalId: string): AssistantProposal | null {
  for (const t of turns) for (const p of t.proposals ?? []) if (p.id === proposalId) return p;
  return null;
}

/** Turns with one proposal replaced; the original array is left alone. */
export function updateProposal(turns: AssistantTurn[], proposalId: string, update: (p: AssistantProposal) => AssistantProposal): AssistantTurn[] {
  return turns.map((t) => (t.proposals?.some((p) => p.id === proposalId) ? { ...t, proposals: t.proposals.map((p) => (p.id === proposalId ? update(p) : p)) } : t));
}

/** Routes that open proposals were made against. */
export function openRouteIds(turns: AssistantTurn[]): string[] {
  return [...new Set(turns.flatMap((t) => (t.proposals ?? []).filter((p) => p.status === "open" && p.routeId).map((p) => p.routeId!)))];
}

/**
 * Marks open proposals stale when their route's version moved on (or the
 * route is gone: null). Returns null when nothing changed.
 */
export function markStale(turns: AssistantTurn[], versions: Map<string, number | null>): AssistantTurn[] | null {
  let changed = false;
  const out = turns.map((t) => {
    if (!t.proposals?.length) return t;
    const proposals = t.proposals.map((p) => {
      if (p.status !== "open" || !p.routeId || !versions.has(p.routeId)) return p;
      const now = versions.get(p.routeId);
      if (now === p.version) return p;
      changed = true;
      return { ...p, status: "stale" as const, note: now == null ? "That route was deleted." : PROPOSAL_STALE_MESSAGE };
    });
    return { ...t, proposals };
  });
  return changed ? out : null;
}

/**
 * After the member applies a suggestion, other open suggestions made against
 * the same version of that route move to the new version: the only change in
 * between is the one they just applied, and the API still checks each one.
 */
export function advanceVersions(turns: AssistantTurn[], routeId: string, from: number, to: number): AssistantTurn[] {
  if (from === to) return turns;
  return turns.map((t) =>
    t.proposals?.some((p) => p.status === "open" && p.routeId === routeId && p.version === from)
      ? { ...t, proposals: t.proposals.map((p) => (p.status === "open" && p.routeId === routeId && p.version === from ? { ...p, version: to } : p)) }
      : t,
  );
}
