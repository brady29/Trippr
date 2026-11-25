import { suggestionsQuery, type SuggestionsResponse } from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { notFound } from "../errors";
import { createRecommend } from "../services/recommend/service";
import type { Search } from "../services/search/service";

const idParams = z.object({ id: z.string().min(1) });

/**
 * "Suggested for this stop" (docs/data-platform-spec.md, Feature 4, Recommendations). Same conventions as the other read
 * routes: a sign-in and at least the viewer role on the trip that owns the stop; a non-member gets 404. It needs no
 * hosted call and has no allowance, so the demo account gets it too.
 */
export function recommendRoutes(app: FastifyInstance, ctx: AppContext, options: { search: Pick<Search, "vectorMatrix"> }) {
  const { guards, repos, log } = ctx;
  const recommend = createRecommend({ repos, search: options.search, log });

  /** ?limit=&bestTime=&indoor= : the places the group is likely to like next in this stop's city, each with its reason. */
  app.get("/stops/:id/suggestions", async (req): Promise<SuggestionsResponse> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.stop(user, id, "viewer");
    const params = ctx.parse(suggestionsQuery, req.query);
    const response = await recommend.run(user.id, id, params);
    if (!response) throw notFound("Stop");
    return response;
  });
}
