import type { City, LibraryActivity, PlaceBody, PlaceLookupResult } from "@trippr/contracts";
import { isGoogleMapsLink, isShortMapsLink, judgeDistance, parseMapLink, type LatLon } from "@trippr/rules";
import { badRequest, notFound } from "../../errors";
import type { Repositories } from "../../repositories";
import type { Geocoder, GeoResult } from "./geocoder";

/** A remembered "not found" is retried after a week; a found point is reused for 90 days. */
const MISS_TTL_MS = 7 * 24 * 3600_000;
const HIT_TTL_MS = 90 * 24 * 3600_000;

const normalise = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export interface PlacesDeps {
  repos: Repositories;
  geocoder: Geocoder;
  /** Follows a short Google Maps share link to the full link (tests replace it). */
  resolveShortLink?: (url: string) => Promise<string | null>;
}

/**
 * Follows maps.app.goo.gl / goo.gl/maps redirects, at most three hops, and
 * only while they stay on Google Maps. The API fetches no other user-supplied URL.
 */
export async function followShortMapsLink(url: string): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    if (!isShortMapsLink(current)) return isGoogleMapsLink(current) ? current : null;
    try {
      const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      const next = res.headers.get("location");
      if (!next) return null;
      current = new URL(next, current).toString();
    } catch {
      return null;
    }
  }
  return isGoogleMapsLink(current) ? current : null;
}

export function createPlaces({ repos, geocoder, resolveShortLink = followShortMapsLink }: PlacesDeps) {
  async function geocode(text: string, city: City): Promise<GeoResult | null> {
    const key = `${geocoder.name}|${city.countryIso ?? ""}|${normalise(text)}`;
    const cached = await repos.places.cached(key);
    if (cached) {
      const age = Date.now() - Date.parse(cached.fetchedAt);
      if (cached.found && cached.lat != null && cached.lon != null && age < HIT_TTL_MS) {
        return { lat: cached.lat, lon: cached.lon, address: cached.address, osmId: cached.osmId };
      }
      if (!cached.found && age < MISS_TTL_MS) return null;
    }
    const hit = await geocoder.search({ text, near: { lat: city.lat, lon: city.lon }, countryIso: city.countryIso });
    await repos.places.remember(key, {
      found: Boolean(hit),
      lat: hit?.lat ?? null,
      lon: hit?.lon ?? null,
      address: hit?.address ?? null,
      osmId: hit?.osmId ?? null,
    });
    return hit;
  }

  return {
    get enabled() {
      return geocoder.name !== "none";
    },

    /**
     * Find an activity's pin from its name and city: the Maps search text first
     * (when someone set one), then "title, city". A point near the city is
     * placed; one at day-trip distance is kept but marked for a person to check.
     * Pins someone placed by hand are left alone.
     */
    async lookup(activity: LibraryActivity): Promise<PlaceLookupResult["outcome"]> {
      if (activity.placeStatus === "manual") return "skipped";
      const city = await repos.cities.get(activity.cityCode);
      if (!city) throw notFound(`City ${activity.cityCode}`);
      const attempts = [...new Set([activity.mapsQuery?.trim(), `${activity.title}, ${city.name}`].filter((t): t is string => Boolean(t)))];
      for (const text of attempts) {
        const hit = await geocode(text, city);
        if (!hit) continue;
        const verdict = judgeDistance(hit, city);
        if (verdict === "too_far") continue;
        await repos.activities.setPlace(activity.id, { point: hit, address: hit.address, status: verdict, source: "osm" });
        return verdict;
      }
      await repos.activities.setPlace(activity.id, { point: null, status: "not_found", source: null });
      return "not_found";
    },

    /** A point for some text near a city (cached), without touching any activity. */
    find(text: string, city: City): Promise<GeoResult | null> {
      return geocode(text, city);
    },

    /**
     * Put a pin the inbox lookup found (from the geocoder, never from the model).
     * "check" keeps the point but asks a person to look; "not_found" and null
     * leave no point (null: the geocoder is off). A shared Google Maps link is
     * kept either way. A pin someone placed by hand is never replaced.
     */
    async pinFound(
      activity: Pick<LibraryActivity, "id" | "placeStatus">,
      found: { point: LatLon | null; address: string | null; status: "placed" | "check" | "not_found" | null; mapsUrl?: string | null },
    ): Promise<boolean> {
      if (activity.placeStatus === "manual") return false;
      const pinned = found.point != null && (found.status === "placed" || found.status === "check");
      await repos.activities.setPlace(activity.id, {
        point: pinned ? found.point : null,
        address: pinned ? found.address : null,
        status: pinned ? found.status! : found.status === null ? "unplaced" : "not_found",
        source: pinned ? "osm" : null,
        ...(found.mapsUrl ? { mapsUrl: found.mapsUrl } : {}),
      });
      return true;
    },

    /** Put the pin where a person says: coordinates, a map link, or nowhere. */
    async place(activity: LibraryActivity, body: PlaceBody): Promise<void> {
      if ("clear" in body) {
        await repos.activities.setPlace(activity.id, { point: null, status: "unplaced", source: null, mapsUrl: null });
        return;
      }
      if ("lat" in body) {
        await repos.activities.setPlace(activity.id, { point: { lat: body.lat, lon: body.lon }, status: "manual", source: "manual" });
        return;
      }
      const short = isShortMapsLink(body.link);
      const link = short ? await resolveShortLink(body.link) : body.link;
      const point: LatLon | null = link ? parseMapLink(link) : null;
      if (!point) {
        throw badRequest(
          "That link doesn't include a location. Open the place in Google Maps and share it, or paste coordinates like 35.6595, 139.7004.",
        );
      }
      const keepLink = short || isGoogleMapsLink(body.link);
      await repos.activities.setPlace(activity.id, {
        point,
        status: "manual",
        source: "manual",
        ...(keepLink ? { mapsUrl: body.link } : {}),
      });
    },
  };
}

export type Places = ReturnType<typeof createPlaces>;
