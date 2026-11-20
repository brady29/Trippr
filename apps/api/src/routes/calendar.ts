import { createHash, randomBytes } from "node:crypto";
import { calendarFeedBody, hasRole, type CalendarFeedLink, type CalendarFeedStatus } from "@trippr/contracts";
import { buildItinerary } from "@trippr/rules";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { forbidden, notFound } from "../errors";
import { itineraryToIcs, type FeedPlace } from "../services/export";
import { buildRouteView } from "../services/route-view";

const idParams = z.object({ id: z.string().min(1) });
const fileParams = z.object({ file: z.string() });
/** <43-character base64url token>.ics; anything else is a 404 without a lookup. */
const FEED_FILE = /^([A-Za-z0-9_-]{32,128})\.ics$/;

/** 32 random bytes, base64url. Shown to the member once; only its hash is stored. */
export const newFeedToken = () => randomBytes(32).toString("base64url");
export const hashFeedToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/**
 * Calendar feeds: each member's private link to the trip's current route,
 * which calendar apps poll. The token is the only credential on the feed
 * itself, so membership and role are checked again on every fetch.
 */
export function calendarRoutes(app: FastifyInstance, ctx: AppContext) {
  const { repos, guards, config } = ctx;

  /** The API's public address: PUBLIC_API_URL, or the address this request came in on (behind a proxy, trustProxy is on). */
  const publicBase = (req: FastifyRequest) => (config.PUBLIC_API_URL ?? `${req.protocol}://${req.host}`).replace(/\/+$/, "");

  const links = (req: FastifyRequest, token: string, includePrivate: boolean): CalendarFeedLink => {
    const url = `${publicBase(req)}/cal/${token}.ics`;
    const webcalUrl = url.replace(/^https?:/, "webcal:");
    return {
      url,
      webcalUrl,
      googleUrl: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`,
      includePrivate,
    };
  };

  /** Whether I have a feed for this trip and what it includes. Never the token. */
  app.get("/trips/:id/calendar", async (req): Promise<CalendarFeedStatus> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role } = await guards.trip(user, id, "viewer");
    const feed = await repos.calendar.get(user.id, id);
    return {
      enabled: feed !== null,
      includePrivate: feed?.includePrivate ?? false,
      createdAt: feed?.createdAt ?? null,
      canIncludePrivate: hasRole(role, "editor") && !user.isDemo,
    };
  });

  /** Create my feed, or make a new link (the old one stops working). */
  app.post("/trips/:id/calendar", async (req, reply): Promise<CalendarFeedLink> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role } = await guards.trip(user, id, "viewer");
    const body = ctx.parse(calendarFeedBody, req.body);
    const includePrivate = body.includePrivate === true;
    if (includePrivate && !hasRole(role, "editor")) throw forbidden("Only editors can include booking references");
    const token = newFeedToken();
    const feed = await repos.calendar.replace(user.id, id, hashFeedToken(token), includePrivate);
    reply.status(201).header("cache-control", "no-store");
    return links(req, token, feed.includePrivate);
  });

  /** Turn my feed off. */
  app.delete("/trips/:id/calendar", async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "viewer");
    await repos.calendar.remove(user.id, id);
    reply.status(204);
  });

  /**
   * The feed. No sign-in: the token in the path is the credential. Unknown,
   * rotated and revoked tokens all get the same bare 404.
   */
  app.get("/cal/:file", async (req, reply) => {
    const { file } = ctx.parse(fileParams, req.params);
    const match = FEED_FILE.exec(file);
    if (!match) throw notFound("Calendar");
    const owner = await repos.calendar.byHash(hashFeedToken(match[1]!));
    if (!owner) throw notFound("Calendar");
    if (!owner.role) {
      // They left or were removed from the trip: the link dies for good.
      await repos.calendar.remove(owner.userId, owner.tripId);
      throw notFound("Calendar");
    }
    const routeId = await repos.calendar.currentRouteId(owner.tripId);
    const stored = routeId ? await repos.routes.load(routeId) : null;
    if (!routeId || !stored) throw notFound("Calendar");

    // The member's current role decides, so a demoted editor's feed loses booking references.
    const view = buildRouteView(stored, owner.role);
    const includePrivate = owner.includePrivate && hasRole(owner.role, "editor");
    const [refs, activities] = await Promise.all([
      includePrivate ? repos.calendar.legRefs(routeId) : Promise.resolve([]),
      repos.activities.list(owner.tripId, owner.userId),
    ]);
    const places = new Map<string, FeedPlace>(
      activities.map((a) => [
        a.id,
        {
          countryIso: a.countryIso ?? null,
          mapsQuery: a.mapsQuery ?? null,
          address: a.address ?? null,
          lat: a.lat ?? null,
          lon: a.lon ?? null,
          url: a.url ?? null,
          website: a.website ?? null,
          ticketUrl: a.ticketUrl ?? null,
          reserveUrl: a.reserveUrl ?? null,
          mapsUrl: a.mapsUrl ?? null,
        },
      ]),
    );

    reply
      .header("content-type", "text/calendar; charset=utf-8")
      .header("cache-control", "private, max-age=900")
      .header("content-disposition", 'inline; filename="trippr.ics"');
    return itineraryToIcs(view, buildItinerary(view.stops), {
      webUrl: config.PUBLIC_WEB_URL,
      places,
      includePrivate,
      ...(includePrivate ? { legRefs: new Map(refs.map((r) => [r.id, r])) } : {}),
    });
  });
}
