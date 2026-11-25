import { hotelSuggestionsQuery, stayCellsQuery, type AreaStay, type HotelSuggestionsResponse, type StayCellsResponse } from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { notFound } from "../errors";
import { attributionOf, buildAreaStay, cellsResponse, rankHotels, toSuggestion } from "../services/stay";

const idParams = z.object({ id: z.string().min(1) });

/**
 * Stay analytics (docs/data-platform-spec.md, Feature 5). Same conventions as the other trip routes: every read needs a
 * sign-in and at least the viewer role on the trip that owns the Area (or on the trip you ask about). The numbers are
 * Inside Airbnb aggregates (CC BY 4.0): no listing ids, host ids, names or links to individual listings exist in the graph.
 */
export function stayRoutes(app: FastifyInstance, ctx: AppContext) {
  const { repos, guards } = ctx;

  /** The Area's stay card: score with its parts, the sentence that explains it, snapshot date and a coverage note. */
  app.get("/areas/:id/stay", async (req): Promise<AreaStay> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.area(user, id, "viewer");
    const area = await repos.stay.areaCard(id);
    if (!area) throw notFound("Area");
    const [load, market] = await Promise.all([repos.stay.latestLoad(), repos.stay.cityMarket(area.cityCode)]);
    return buildAreaStay(area, { load, cityCovered: market != null, attribution: attributionOf(load?.stay) });
  });

  /**
   * H3 cells for the "Stay prices" map layer: for a city, a viewport (bbox=minLon,minLat,maxLon,maxLat) or both. At most
   * `limit` cells (default 1500); `truncated` says when more matched.
   */
  app.get("/trips/:id/stay/cells", async (req): Promise<StayCellsResponse> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "viewer");
    const query = ctx.parse(stayCellsQuery, req.query);
    const [markets, load] = await Promise.all([
      repos.stay.markets({ ...(query.city ? { city: query.city } : {}), ...(query.bbox ? { bbox: query.bbox } : {}), layer: query.layer }),
      repos.stay.latestLoad(),
    ]);
    return cellsResponse(markets, {
      ...(query.bbox ? { bbox: query.bbox } : {}),
      limit: query.limit,
      layer: query.layer,
      attribution: attributionOf(load?.stay),
    });
  });

  /** Open-data hotels (Overture, Foursquare, OpenStreetMap) inside the Area's radius, best first. Never priced, never booked. */
  app.get("/areas/:id/hotel-suggestions", async (req): Promise<HotelSuggestionsResponse> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.area(user, id, "viewer");
    const { limit } = ctx.parse(hotelSuggestionsQuery, req.query);
    const area = await repos.stay.areaCard(id);
    if (!area) throw notFound("Area");
    const all = rankHotels(await repos.stay.hotelsForArea(id));
    const hotels = all.slice(0, limit);
    const used = [...new Set(hotels.flatMap((h) => h.sources.map((s) => s.source)))];
    const sources = await repos.stay.sourceAttributions(used);
    return {
      areaId: area.id,
      areaName: area.name,
      cityCode: area.cityCode,
      cityName: area.cityName,
      hotels: hotels.map(toSuggestion),
      total: all.length,
      attributions: sources.map((s) => `${s.attribution} (${s.licence})`),
    };
  });
}
