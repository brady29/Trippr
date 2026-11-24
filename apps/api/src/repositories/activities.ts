import {
  BEST_TIMES,
  GOOD_FOR,
  PRICE_LEVELS,
  type Activity,
  type ActivityEnrichment,
  type ActivityFacets,
  type ActivityPage,
  type ActivityPageParams,
  type ActivitySource,
  type BestTime,
  type Comment,
  type GoodFor,
  type LibraryActivity,
  type PriceLevel,
} from "@trippr/contracts";
import { PLACE_STATUSES, type PlaceStatus, type When } from "@trippr/rules";
import type { GraphClient } from "../db/graph";
import { newId, nowIso } from "../ids";
import { cypher } from "./queries";
import { num, optNum, parseJson, toJson } from "./util";

/** The activity properties every read returns (see the map projections in the .cypher files). */
export type ActivityNode = {
  id: string;
  title: string;
  when: unknown;
  url: string | null;
  costCad: unknown;
  mapsQuery?: string | null;
  website?: string | null;
  ticketUrl?: string | null;
  reserveUrl?: string | null;
  mapsUrl?: string | null;
  lat?: unknown;
  lon?: unknown;
  address?: string | null;
  placeStatus?: string | null;
  /** Set on places that came from, or were matched to, the data pipeline's catalogue. */
  catalogue?: boolean | null;
  category?: string | null;
  score?: unknown;
  rank?: unknown;
  listed?: boolean | null;
  nameLocal?: string | null;
  phone?: string | null;
  openingHours?: string | null;
  /** JSON: [{ source, sourceId, licence }]. */
  sources?: unknown;
  /** LLM enrichment (catalogue places the enrich stage covered). */
  enrichedAt?: string | null;
  enrichModel?: string | null;
  summary?: string | null;
  summaryAi?: boolean | null;
  aiLabel?: string | null;
  enrichTags?: string[] | null;
  durationMin?: unknown;
  bestTime?: string | null;
  indoor?: boolean | null;
  priceLevel?: string | null;
  goodFor?: string[] | null;
  displayName?: string | null;
  genericName?: boolean | null;
};

/** The enrichment DTO, or nothing when the enrich stage never covered the place. */
export function enrichmentFields(a: ActivityNode): { enrichment: ActivityEnrichment } | Record<string, never> {
  if (a.enrichedAt == null) return {};
  const summary = a.summary?.trim() ? a.summary : null;
  return {
    enrichment: {
      tags: a.enrichTags ?? [],
      summary,
      // The AI flag only ever travels with a summary; a hand-written summary would have no flag.
      summaryAi: summary != null && a.summaryAi === true,
      aiLabel: summary != null && a.summaryAi === true ? (a.aiLabel ?? "Summary written by AI") : null,
      durationMin: optNum(a.durationMin),
      bestTime: BEST_TIMES.includes(a.bestTime as BestTime) ? (a.bestTime as BestTime) : null,
      indoor: typeof a.indoor === "boolean" ? a.indoor : null,
      priceLevel: PRICE_LEVELS.includes(a.priceLevel as PriceLevel) ? (a.priceLevel as PriceLevel) : null,
      goodFor: (a.goodFor ?? []).filter((g): g is GoodFor => GOOD_FOR.includes(g as GoodFor)),
      displayName: a.displayName ?? null,
      isGenericName: a.genericName === true,
      model: a.enrichModel ?? null,
      enrichedAt: a.enrichedAt,
    },
  };
}

/** Fields shared by every activity DTO, from the stored node. */
export function activityFields(a: ActivityNode) {
  const lat = optNum(a.lat);
  const lon = optNum(a.lon);
  const pinned = lat != null && lon != null;
  const status = PLACE_STATUSES.includes(a.placeStatus as PlaceStatus) ? (a.placeStatus as PlaceStatus) : "unplaced";
  return {
    id: a.id,
    title: a.title,
    when: parseJson<When>(a.when),
    url: a.url ?? null,
    mapsQuery: a.mapsQuery ?? null,
    costCad: optNum(a.costCad),
    website: a.website ?? null,
    ticketUrl: a.ticketUrl ?? null,
    reserveUrl: a.reserveUrl ?? null,
    mapsUrl: a.mapsUrl ?? null,
    lat: pinned ? lat : null,
    lon: pinned ? lon : null,
    address: a.address ?? null,
    placeStatus: pinned || status === "not_found" ? status : "unplaced",
    ...(a.catalogue === true ? { catalogue: true as const, listed: a.listed !== false } : {}),
    ...(a.category != null ? { category: a.category } : {}),
    ...(a.score != null ? { score: num(a.score) } : {}),
    ...(a.rank != null ? { rank: num(a.rank) } : {}),
    ...(a.nameLocal != null ? { nameLocal: a.nameLocal } : {}),
    ...(a.phone != null ? { phone: a.phone } : {}),
    ...(a.openingHours != null ? { openingHours: a.openingHours } : {}),
    ...(a.sources != null ? { sources: parseJson<ActivitySource[]>(a.sources) ?? [] } : {}),
    ...enrichmentFields(a),
  } satisfies Partial<Activity>;
}

type Row = {
  activity: ActivityNode;
  cityCode: string;
  cityName: string;
  countryIso: string | null;
  votes: number;
  myVote: number;
  tags: string[];
  commentCount: number;
  plannedIn: { routeId: string | null; routeName: string | null; stopId: string | null }[];
};

export function activitiesRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };

  async function list(
    tripId: string,
    userId: string,
    filter: { cityCode?: string; activityId?: string; ids?: string[] } = {},
  ): Promise<LibraryActivity[]> {
    const rows = await db.query<Row>(
      q("activities/list"),
      { tripId, userId, cityCode: filter.cityCode ?? null, activityId: filter.activityId ?? null, ids: filter.ids ?? null },
      read,
    );
    return rows.map((r) => ({
      ...activityFields(r.activity),
      tags: [...(r.tags ?? [])].sort(),
      cityCode: r.cityCode,
      cityName: r.cityName,
      countryIso: r.countryIso ?? null,
      votes: num(r.votes),
      myVote: Math.sign(num(r.myVote)) as -1 | 0 | 1,
      commentCount: num(r.commentCount),
      plannedIn: (r.plannedIn ?? [])
        .filter((p) => p && p.routeId != null)
        .map((p) => ({ routeId: String(p.routeId), routeName: String(p.routeName), stopId: String(p.stopId) })),
    }));
  }

  /** The filtered, ordered, paged view of the whole library, catalogue included. */
  async function page(tripId: string, userId: string, query: ActivityPageParams): Promise<ActivityPage> {
    const matches = await db.query<{ id: string }>(
      q("activities/page-ids"),
      {
        tripId,
        scope: query.scope,
        cityCode: query.city ?? null,
        tag: query.tag ?? null,
        category: query.category ?? null,
        source: query.source ?? null,
        minScore: query.minScore ?? null,
        maxRank: query.maxRank ?? null,
        fixedDates: query.fixedDates,
        includeUnlisted: query.includeUnlisted,
        bestTime: query.bestTime ?? null,
        indoor: query.indoor ?? null,
        durationMax: query.durationMax ?? null,
        priceLevel: query.priceLevel ?? null,
        q: query.q ? query.q.toLowerCase() : null,
        sort: query.sort,
      },
      read,
    );
    const ids = matches.map((m) => m.id);
    const pageIds = ids.slice(query.offset, query.offset + query.limit);
    const rows = pageIds.length ? await list(tripId, userId, { ids: pageIds }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const end = query.offset + pageIds.length;
    return {
      items: pageIds.map((id) => byId.get(id)).filter((r): r is LibraryActivity => r !== undefined),
      total: ids.length,
      offset: query.offset,
      limit: query.limit,
      nextOffset: end < ids.length ? end : null,
    };
  }

  async function facets(tripId: string): Promise<ActivityFacets> {
    const params = { tripId };
    const [cities, tags, categories, sources, totals, enrichment] = await Promise.all([
      db.query<{ code: string; name: string; n: unknown }>(q("activities/facet-cities"), params, read),
      db.query<{ name: string; n: unknown }>(q("activities/facet-tags"), params, read),
      db.query<{ name: string; n: unknown }>(q("activities/facet-categories"), params, read),
      db.query<{ id: string; name: string; n: unknown }>(q("activities/facet-sources"), params, read),
      db.query<{ ideas: unknown; catalogue: unknown; planned: unknown; onMap: unknown; cities: unknown }>(
        q("activities/facet-totals"),
        params,
        read,
      ),
      db.query<Record<string, unknown>>(q("activities/facet-enrichment"), params, read),
    ]);
    const t = totals[0];
    const e = enrichment[0] ?? {};
    return {
      cities: cities.map((c) => ({ code: c.code, name: c.name, count: num(c.n) })),
      tags: tags.map((x) => ({ name: x.name, count: num(x.n) })),
      categories: categories.map((x) => ({ name: x.name, count: num(x.n) })),
      sources: sources.map((x) => ({ id: x.id, name: x.name, count: num(x.n) })),
      enrichment: {
        enriched: num(e.enriched),
        bestTimes: BEST_TIMES.map((name) => ({ name, count: num(e[name === "any" ? "anyTime" : name]) })),
        priceLevels: [
          { name: "free" as const, count: num(e.free) },
          { name: "$" as const, count: num(e.cheap) },
          { name: "$$" as const, count: num(e.moderate) },
          { name: "$$$" as const, count: num(e.expensive) },
        ],
        indoor: num(e.indoor),
        outdoor: num(e.outdoor),
        durations: [30, 60, 120, 240].map((max) => ({ max, count: num(e[`upTo${max}`]) })),
      },
      totals: {
        ideas: num(t?.ideas),
        catalogue: num(t?.catalogue),
        planned: num(t?.planned),
        onMap: num(t?.onMap),
        cities: num(t?.cities),
      },
    };
  }

  return {
    list,
    page,
    facets,

    async get(tripId: string, userId: string, activityId: string) {
      return (await list(tripId, userId, { activityId }))[0] ?? null;
    },

    async create(
      userId: string,
      input: {
        tripId: string;
        cityCode: string;
        title: string;
        tags: string[];
        when?: When | null;
        url?: string | null;
        costCad?: number | null;
        website?: string | null;
        ticketUrl?: string | null;
        reserveUrl?: string | null;
      },
    ) {
      const id = newId("act");
      await db.query(q("activities/create"), {
        id,
        userId,
        tripId: input.tripId,
        cityCode: input.cityCode,
        title: input.title,
        tags: input.tags,
        when: toJson(input.when),
        url: input.url ?? null,
        costCad: input.costCad ?? null,
        website: input.website ?? null,
        ticketUrl: input.ticketUrl ?? null,
        reserveUrl: input.reserveUrl ?? null,
        now: nowIso(),
      });
      return id;
    },

    async patch(
      activityId: string,
      input: {
        title?: string;
        tags?: string[];
        when?: When | null;
        url?: string | null;
        costCad?: number | null;
        website?: string | null;
        ticketUrl?: string | null;
        reserveUrl?: string | null;
      },
    ) {
      await db.query(q("activities/patch"), {
        activityId,
        title: input.title ?? null,
        setUrl: input.url !== undefined,
        url: input.url ?? null,
        setWhen: input.when !== undefined,
        when: toJson(input.when),
        setCost: input.costCad !== undefined,
        costCad: input.costCad ?? null,
        setWebsite: input.website !== undefined,
        website: input.website ?? null,
        setTicketUrl: input.ticketUrl !== undefined,
        ticketUrl: input.ticketUrl ?? null,
        setReserveUrl: input.reserveUrl !== undefined,
        reserveUrl: input.reserveUrl ?? null,
      });
      if (input.tags) await db.query(q("activities/set-tags"), { activityId, tags: input.tags });
    },

    /**
     * Set the pin (lat/lon with its address and how it was found) or clear it
     * (point null). mapsUrl undefined leaves the stored Google Maps link alone.
     */
    async setPlace(
      activityId: string,
      place: {
        point: { lat: number; lon: number } | null;
        address?: string | null;
        status: PlaceStatus;
        source: "osm" | "manual" | null;
        mapsUrl?: string | null;
      },
    ) {
      await db.query(q("activities/place"), {
        activityId,
        lat: place.point?.lat ?? null,
        lon: place.point?.lon ?? null,
        address: place.address ?? null,
        status: place.status,
        source: place.source,
        now: nowIso(),
        setMapsUrl: place.mapsUrl !== undefined,
        mapsUrl: place.mapsUrl ?? null,
      });
    },

    /** A hand-written activity is deleted; a catalogue place is hidden, or the load job would add it back. */
    async delete(activityId: string) {
      const hidden = await db.query(q("activities/hide"), { activityId });
      if (hidden.length === 0) await db.query(q("activities/delete"), { activityId });
    },

    async vote(userId: string, activityId: string, value: -1 | 0 | 1) {
      if (value === 0) await db.query(q("activities/unvote"), { userId, activityId });
      else await db.query(q("activities/vote"), { userId, activityId, value, now: nowIso() });
    },

    async addComment(userId: string, activityId: string, text: string) {
      const id = newId("cm");
      await db.query(q("activities/comment-create"), { id, userId, activityId, text, now: nowIso() });
      return id;
    },

    async comments(activityId: string): Promise<Comment[]> {
      const rows = await db.query<{
        comment: { id: string; text: string; at: string };
        authorId: string;
        authorName: string;
      }>(q("activities/comment-list"), { activityId }, read);
      return rows.map((r) => ({ ...r.comment, author: { id: r.authorId, name: r.authorName } }));
    },
  };
}
