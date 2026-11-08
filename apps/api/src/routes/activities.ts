import {
  cityCode,
  commentBody,
  createActivityBody,
  patchActivityBody,
  tripQuery,
  voteBody,
  type LibraryActivity,
} from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { notFound } from "../errors";

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
    });
    return repos.activities.get(tripId, user.id, id);
  });

  /** { value: 1 or -1 }; 0 clears your vote. Viewers can vote. */
  app.put("/activities/:id/vote", async (req) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { tripId } = await guards.activity(user, id, "viewer");
    const { value } = ctx.parse(voteBody, req.body);
    await repos.activities.vote(user.id, id, value);
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
    await guards.activity(user, id, "viewer");
    const { text } = ctx.parse(commentBody, req.body);
    await repos.activities.addComment(user.id, id, text);
    reply.status(201);
    return repos.activities.comments(id);
  });
}
