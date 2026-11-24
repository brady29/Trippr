import { searchQuery, type SearchResponse } from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { AppError } from "../errors";
import type { QueryEmbedder } from "../services/search/embedder";
import { createSearch } from "../services/search/service";

const idParams = z.object({ id: z.string().min(1) });

export function searchRoutes(app: FastifyInstance, ctx: AppContext, options: { embedder?: QueryEmbedder | null | undefined } = {}) {
  const { config, guards, repos, log } = ctx;
  const search = createSearch({ repos, config, log, embedder: options.embedder });

  /**
   * Semantic search over the trip's activities: ?q=&city=&tag=&category=&near=lat,lon&km=&limit=.
   * Viewers can search. Ranks by meaning (vectors) and by words together; without a query embedder, vectors or
   * allowance it answers on words alone and says so in `notice`. 429 when a member searches too fast.
   */
  app.get("/trips/:id/search", async (req, reply): Promise<SearchResponse> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "viewer");
    const params = ctx.parse(searchQuery, req.query);
    const wait = search.governor.hit(user.id);
    if (wait !== null) {
      reply.header("retry-after", String(wait));
      throw new AppError(429, "rate_limited", `You are searching quickly. Try again in ${wait} second${wait === 1 ? "" : "s"}.`);
    }
    return search.run({ id: user.id, isDemo: user.isDemo }, id, params);
  });

  return search;
}
