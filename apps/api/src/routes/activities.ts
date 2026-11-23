import {
  activityPageQuery,
  cityCode,
  commentBody,
  createActivityBody,
  patchActivityBody,
  placeBody,
  tripQuery,
  voteBody,
  type ActivityFacets,
  type ActivityPage,
  type LibraryActivity,
  type PlaceLookupResult,
} from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { AppError, notFound } from "../errors";

const idParams = z.object({ id: z.string().min(1) });

export function activityRoutes(app: FastifyInstance, ctx: AppContext) {
  const { repos, guards } = ctx;

  /** Every activity in the trip, for the library screen. */
  app.get("/trips/:id/activities", async (req): Promise<LibraryActivity[]> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "viewer");
    return repos.activities.list(id, user.id);
  });

  /**
   * The whole library, catalogue included, filtered and paged: ?scope=all|mine|catalogue&city=&tag=&category=
   * &q=&source=&minScore=&maxRank=&fixedDates=&sort=relevance|score|title&offset=&limit= (50 by default).
   */
  app.get("/trips/:id/activities/page", async (req): Promise<ActivityPage> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "viewer");
    return repos.activities.page(id, user.id, ctx.parse(activityPageQuery, req.query));
  });

  /** What the filter menus offer and the library's headline numbers. */
  app.get("/trips/:id/activities/facets", async (req): Promise<ActivityFacets> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "viewer");
    return repos.activities.facets(id);
  });

  /** The shared library for one city. */
  app.get("/cities/:code/activities", async (req): Promise<LibraryActivity[]> => {
    const user = ctx.user(req);
    const { code } = ctx.parse(z.object({ code: cityCode }), req.params);
    const { tripId } = ctx.parse(tripQuery, req.query);
    await guards.trip(user, tripId, "viewer");
    return repos.activities.list(tripId, user.id, { cityCode: code });
  });

  /** Create an activity once; it shows up in every route that stops in its city. */
  app.post("/activities", async (req, reply) => {
    const user = ctx.user(req);
    const body = ctx.parse(createActivityBody, req.body);
    await guards.trip(user, body.tripId, "editor");
    if (!(await repos.cities.get(body.cityCode))) throw notFound(`City ${body.cityCode}`);
    const id = await repos.activities.create(user.id, body);
    ctx.notify(body.tripId, { kind: "activities" }, user.id);
    reply.status(201);
    return repos.activities.get(body.tripId, user.id, id);
  });

  /** Edit an activity everywhere it appears. */
  app.patch("/activities/:id", async (req) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.activity(user, id, "editor");
    const body = ctx.parse(patchActivityBody, req.body);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    // Distinguish "leave as is" (absent) from "clear" (null).
    await repos.activities.patch(id, {
      title: body.title,
      tags: body.tags,
      ...("when" in raw ? { when: body.when ?? null } : {}),
      ...("url" in raw ? { url: body.url ?? null } : {}),
      ...("costCad" in raw ? { costCad: body.costCad ?? null } : {}),
      ...("website" in raw ? { website: body.website ?? null } : {}),
      ...("ticketUrl" in raw ? { ticketUrl: body.ticketUrl ?? null } : {}),
      ...("reserveUrl" in raw ? { reserveUrl: body.reserveUrl ?? null } : {}),
    });
    ctx.notify(tripId, { kind: "activities" }, user.id);
    return repos.activities.get(tripId, user.id, id);
  });

  /** Find the activity's pin from its name and city (OpenStreetMap). */
  app.post("/activities/:id/lookup", async (req): Promise<PlaceLookupResult> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.activity(user, id, "editor");
    if (!ctx.places.enabled) throw new AppError(503, "unavailable", "Finding places is turned off on this server");
    const activity = await repos.activities.get(tripId, user.id, id);
    if (!activity) throw notFound("Activity");
    const outcome = await ctx.places.lookup(activity);
    if (outcome !== "skipped") ctx.notify(tripId, { kind: "activities" }, user.id);
    return { activity: (await repos.activities.get(tripId, user.id, id))!, outcome };
  });

  /** Put the pin somewhere by hand: { lat, lon }, { link } (Google or Apple Maps) or { clear: true }. */
  app.patch("/activities/:id/place", async (req) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.activity(user, id, "editor");
    const body = ctx.parse(placeBody, req.body);
    const activity = await repos.activities.get(tripId, user.id, id);
    if (!activity) throw notFound("Activity");
    await ctx.places.place(activity, body);
    ctx.notify(tripId, { kind: "activities" }, user.id);
    return repos.activities.get(tripId, user.id, id);
  });

  /** Delete an activity everywhere: unplans it from every route and drops its votes and comments. */
  app.delete("/activities/:id", async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.activity(user, id, "editor");
    await repos.activities.delete(id);
    ctx.notify(tripId, { kind: "activities" }, user.id);
    reply.status(204);
  });

  /** { value: 1 or -1 }; 0 clears your vote. Viewers can vote. */
  app.put("/activities/:id/vote", async (req) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.activity(user, id, "viewer");
    const { value } = ctx.parse(voteBody, req.body);
    await repos.activities.vote(user.id, id, value);
    ctx.notify(tripId, { kind: "activities" }, user.id);
    return repos.activities.get(tripId, user.id, id);
  });

  app.get("/activities/:id/comments", async (req) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.activity(user, id, "viewer");
    return repos.activities.comments(id);
  });

  app.post("/activities/:id/comments", async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.activity(user, id, "viewer");
    const { text } = ctx.parse(commentBody, req.body);
    await repos.activities.addComment(user.id, id, text);
    ctx.notify(tripId, { kind: "activities" }, user.id);
    reply.status(201);
    return repos.activities.comments(id);
  });
}
