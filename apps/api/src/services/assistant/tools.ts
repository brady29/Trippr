import type Anthropic from "@anthropic-ai/sdk";
import type { BookingsResult, CompareResult, Hotel, LibraryActivity, PathResult, RouteView, SearchResponse } from "@trippr/contracts";
import { buildItinerary } from "@trippr/rules";
import { z } from "zod/v4";
import { nearby, trimActivities, trimBookings, trimCompare, trimItinerary, trimPaths, trimRoute, trimSearch, type Seen } from "./helpers";

/** A read-only GET against this API as the asking member. */
export type CallAs = <T>(url: string) => Promise<T>;

export interface ToolContext {
  tripId: string;
  call: CallAs;
  seen: Seen;
  currentRouteId: string | null;
  routeIds: string[];
}

/** A tool failure the model should read and explain (bad input, unknown id). */
export class ToolError extends Error {}

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  label(input: z.output<S>): string;
  run(input: z.output<S>, ctx: ToolContext): Promise<unknown>;
}

const tool = <S extends z.ZodType>(def: ToolDef<S>) => def;

const routeId = z.string().min(1).max(64).describe("A route id from the snapshot. Defaults to the current route.");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const code = z.string().regex(/^[A-Za-z]{3}$/, "City codes are three letters, like CKG");

function pickRoute(ctx: ToolContext, wanted: string | undefined): string {
  const id = wanted ?? ctx.currentRouteId;
  if (!id) throw new ToolError("This trip has no routes yet.");
  if (!ctx.routeIds.includes(id)) throw new ToolError(`No route ${id} in this trip. Route ids: ${ctx.routeIds.join(", ")}.`);
  return id;
}

const round5 = (n: number | null | undefined) => (n == null ? null : Math.round(n * 1e5) / 1e5);

export const TOOLS = [
  tool({
    name: "get_route",
    description:
      "One route in full: stops with dates and nights, tickets (legs) with times and status, hotels per stop with coordinates, planned activities with their day, open checks and the budget per person in CAD.",
    schema: z.object({ routeId: routeId.optional() }),
    label: () => "Looking at the route…",
    async run(input, ctx) {
      const view = await ctx.call<RouteView>(`/routes/${encodeURIComponent(pickRoute(ctx, input.routeId))}`);
      const trimmed = trimRoute(view, ctx.seen);
      // Hotel pins, so near() can start from "our hotel".
      const pins = new Map(view.stops.flatMap((s) => s.stays.map((st) => [st.hotel.id, st.hotel] as const)));
      return {
        ...trimmed,
        stops: trimmed.stops.map((s) => ({
          ...s,
          hotels: s.hotels.map((h) => ({ ...h, lat: round5(pins.get(h.hotelId)?.lat), lon: round5(pins.get(h.hotelId)?.lon) })),
        })),
      };
    },
  }),
  tool({
    name: "get_itinerary",
    description:
      "The route day by day in local time: where you sleep, travel that day, planned activities with start times and clashes, the day type (travel, full, light, free), and activities planned at a stop but not on a day. Optionally only the days from..to.",
    schema: z.object({ routeId: routeId.optional(), from: date.optional().describe("First day, YYYY-MM-DD"), to: date.optional().describe("Last day, YYYY-MM-DD") }),
    label: () => "Checking the day-by-day plan…",
    async run(input, ctx) {
      const view = await ctx.call<RouteView>(`/routes/${encodeURIComponent(pickRoute(ctx, input.routeId))}`);
      return trimItinerary(buildItinerary(view.stops), { from: input.from, to: input.to }, ctx.seen);
    },
  }),
  tool({
    name: "search_activities",
    description:
      "Search the trip's activity ideas (the shared library across all cities). Filter by city code, tags (any of them), words in the title or address, and whether they are planned on the current route. Returns at most 40, most voted first, with coordinates when placed.",
    schema: z.object({
      cityCode: code.optional(),
      tags: z.array(z.string().min(1).max(30)).max(8).optional(),
      text: z.string().max(100).optional(),
      planned: z.boolean().optional().describe("true: only planned on the current route; false: only not planned"),
    }),
    label: (input) => (input.cityCode ? `Searching activity ideas in ${input.cityCode.toUpperCase()}…` : "Searching the activity ideas…"),
    async run(input, ctx) {
      const list = await ctx.call<LibraryActivity[]>(`/trips/${encodeURIComponent(ctx.tripId)}/activities`);
      const result = trimActivities(list, { ...input, cityCode: input.cityCode?.toUpperCase() }, ctx.currentRouteId, ctx.seen);
      const pins = new Map(list.map((a) => [a.id, a]));
      return { ...result, activities: result.activities.map((a) => ({ ...a, lat: round5(pins.get(a.id)?.lat), lon: round5(pins.get(a.id)?.lon) })) };
    },
  }),
  tool({
    name: "get_bookings",
    description:
      "What is booked on the current route (tickets and hotels by date, with prices), what is picked but not booked yet, and the stops still missing a booked hotel or transport. Booking references appear only when the asking member is allowed to see them.",
    schema: z.object({}),
    label: () => "Checking what's booked…",
    async run(_input, ctx) {
      return trimBookings(await ctx.call<BookingsResult>(`/trips/${encodeURIComponent(ctx.tripId)}/bookings`), ctx.seen);
    },
  }),
  tool({
    name: "find_paths",
    description:
      "Pathfinding over the stored train and flight links between two cities (three-letter city codes). mode 'rail' answers 'is there a train at all?'. Returns the cities passed through, each hop's mode, minutes and cost, and totals. Stored links are approximate; say so.",
    schema: z.object({
      from: code,
      to: code,
      mode: z.enum(["any", "rail"]).optional().describe("rail: only rail links"),
      by: z.enum(["minutes", "hops", "costCad"]).optional().describe("What to minimise; minutes by default"),
    }),
    label: (input) => `Looking for a way from ${input.from.toUpperCase()} to ${input.to.toUpperCase()}…`,
    async run(input, ctx) {
      const params = new URLSearchParams({ from: input.from.toUpperCase(), to: input.to.toUpperCase(), by: input.by ?? "minutes" });
      // The API coerces any value to true, so only send it when wanted.
      if (input.mode === "rail") params.set("railOnly", "true");
      return trimPaths(await ctx.call<PathResult>(`/paths?${params}`), ctx.seen);
    },
  }),
  tool({
    name: "near",
    description:
      "Places in this trip within km of a point: activity ideas with a pin, hotels, and the current route's stop cities, nearest first. Get the point from a hotel or activity's lat/lon in another tool result.",
    schema: z.object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      km: z.number().min(0.1).max(50).describe("Radius in kilometres, up to 50"),
    }),
    label: () => "Looking for places nearby…",
    async run(input, ctx) {
      const trip = encodeURIComponent(ctx.tripId);
      const [activities, hotels, view] = await Promise.all([
        ctx.call<LibraryActivity[]>(`/trips/${trip}/activities`),
        ctx.call<Hotel[]>(`/trips/${trip}/hotels`),
        ctx.currentRouteId ? ctx.call<RouteView>(`/routes/${encodeURIComponent(ctx.currentRouteId)}`) : Promise.resolve(null),
      ]);
      return nearby({ lat: input.lat, lon: input.lon }, input.km, { activities, hotels, stops: view?.stops ?? [] }, ctx.seen);
    },
  }),
  tool({
    name: "compare_routes",
    description:
      "Two routes of this trip side by side: shared and unique cities, nights per country, activities planned in one but not the other, and the budget per person.",
    schema: z.object({ a: z.string().min(1).max(64), b: z.string().min(1).max(64) }),
    label: () => "Comparing routes…",
    async run(input, ctx) {
      const a = pickRoute(ctx, input.a);
      const b = pickRoute(ctx, input.b);
      if (a === b) throw new ToolError("Pick two different routes.");
      return trimCompare(await ctx.call<CompareResult>(`/compare?${new URLSearchParams({ a, b })}`), ctx.seen);
    },
  }),
  tool({
    name: "semantic_search",
    description:
      "Find places by what they are like, not just by their words: 'quiet viewpoints at sunset', 'cheap ramen near the hotel', 'temples with gardens'. Searches the whole place catalogue and the group's own ideas together, ranked by meaning and name match, in any language. Optional filters: city code, tag (sport, tech, nature, culture, food), category (viewpoint, temple_shrine, ...), and a point with a radius in km (take the point from a hotel or activity's lat/lon). Returns at most 15 places with why each matched, and says in mode whether meaning-based ranking was used or only words. Use search_activities instead to list the group's own ideas by vote.",
    schema: z.object({
      query: z.string().min(1).max(200).describe("What the person is looking for, in their own words"),
      cityCode: code.optional(),
      tag: z.string().min(1).max(24).optional(),
      category: z.string().min(1).max(40).optional(),
      near: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).optional(),
      km: z.number().min(0.1).max(50).optional().describe("Radius around near, default 5"),
      limit: z.number().int().min(1).max(15).optional().describe("How many places, default 10"),
    }),
    label: (input) => (input.cityCode ? `Searching for "${input.query.slice(0, 40)}" in ${input.cityCode.toUpperCase()}…` : `Searching for "${input.query.slice(0, 40)}"…`),
    async run(input, ctx) {
      const params = new URLSearchParams({ q: input.query, limit: String(input.limit ?? 10) });
      if (input.cityCode) params.set("city", input.cityCode.toUpperCase());
      if (input.tag) params.set("tag", input.tag);
      if (input.category) params.set("category", input.category);
      if (input.near) {
        params.set("near", `${input.near.lat},${input.near.lon}`);
        if (input.km) params.set("km", String(input.km));
      }
      return trimSearch(await ctx.call<SearchResponse>(`/trips/${encodeURIComponent(ctx.tripId)}/search?${params}`), ctx.currentRouteId, ctx.seen);
    },
  }),
];

export type ToolName = (typeof TOOLS)[number]["name"];

/** Tool definitions as the Messages API takes them, in a fixed order so the prompt cache holds. */
export function toolDefinitions(): Anthropic.Beta.BetaTool[] {
  return TOOLS.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    };
  });
}

/** Facts the trip graph doesn't hold: opening hours, visa rules, ticket release dates. */
export const WEB_SEARCH: Anthropic.Beta.BetaWebSearchTool20260209 = { type: "web_search_20260209", name: "web_search", max_uses: 2 };

export function findTool(name: string) {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Validates the model's input against the tool's schema (inputs stream
 * eagerly, so the API does not check them) and returns a label for the
 * activity line plus a runner that calls the API as the asking member.
 * Throws ToolError for an unknown tool or invalid input.
 */
export function prepareTool(name: string, input: unknown, ctx: ToolContext): { label: string; run: () => Promise<unknown> } {
  const def = findTool(name);
  if (!def) throw new ToolError(`There is no tool called ${name}.`);
  const parsed = def.schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new ToolError(`Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`);
  }
  // Each definition's run takes its own schema's output; the union of definitions loses that link.
  const run = def.run as (input: unknown, ctx: ToolContext) => Promise<unknown>;
  const label = (def.label as (input: unknown) => string)(parsed.data);
  return { label, run: () => run(parsed.data, ctx) };
}
