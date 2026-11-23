import type { DataSourcesResponse } from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";

/** Said on the Data page next to the sources; the per-source attribution comes from the source registry. */
const NOTES = [
  "Every place keeps the id and licence of each source record it was built from.",
  "Nothing is scraped: places come from open datasets and official downloads.",
  "Places from OpenStreetMap, when loaded, are ODbL-licensed: the data stays traceable to its source records here, and Trippr does not publish the catalogue as a dataset.",
  "Text from Wikivoyage is CC BY-SA 4.0 and keeps its attribution; AI-written summaries are marked as such.",
];

export function dataRoutes(app: FastifyInstance, ctx: AppContext) {
  /**
   * The Data page's read model: sources with licences and attribution, counts, freshness and the latest quality
   * results. Public (no sign-in): it holds no trip data, and it carries the attribution the licences require.
   */
  app.get("/data/sources", async (): Promise<DataSourcesResponse> => {
    return { ...(await ctx.repos.data.sources()), notes: NOTES };
  });
}
