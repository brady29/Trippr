import type { Activity, Comment, LibraryActivity } from "@trippr/contracts";
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
};

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
    filter: { cityCode?: string; activityId?: string } = {},
  ): Promise<LibraryActivity[]> {
    const rows = await db.query<Row>(
      q("activities/list"),
      { tripId, userId, cityCode: filter.cityCode ?? null, activityId: filter.activityId ?? null },
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

  return {
    list,

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

    async delete(activityId: string) {
      await db.query(q("activities/delete"), { activityId });
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
