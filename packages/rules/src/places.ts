/**
 * Places for activities: where an idea is on the map and which links open it.
 * Pure functions shared by the API (lookup, manual pins) and the web app (link chips).
 */
import { distanceKm } from "./travel";

export const PLACE_STATUSES = ["unplaced", "placed", "check", "manual", "not_found"] as const;
export type PlaceStatus = (typeof PLACE_STATUSES)[number];

export interface LatLon {
  lat: number;
  lon: number;
}

/** A pin closer than this to its city is trusted; up to FAR_KM it's kept but marked for a person to check. */
export const NEAR_KM = 80;
export const FAR_KM = 150;

/** How much to trust a found point, by its distance from the activity's city. */
export function judgeDistance(point: LatLon, city: LatLon): "placed" | "check" | "too_far" {
  const km = distanceKm(point, city);
  if (km <= NEAR_KM) return "placed";
  if (km <= FAR_KM) return "check";
  return "too_far";
}

const validPoint = (lat: number, lon: number): LatLon | null =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)
    ? { lat, lon }
    : null;

/** "35.6595, 139.7004" typed by hand. */
export function parseLatLon(text: string): LatLon | null {
  const m = text.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  return m ? validPoint(Number(m[1]), Number(m[2])) : null;
}

const GOOGLE_MAPS_HOST = /^(www\.)?google\.[a-z.]{2,6}$|^maps\.google\.[a-z.]{2,6}$/;

/** Short share links (maps.app.goo.gl, goo.gl/maps) have to be followed to find the place. */
export function isShortMapsLink(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "maps.app.goo.gl" || (u.hostname === "goo.gl" && u.pathname.startsWith("/maps")));
  } catch {
    return false;
  }
}

/** A full Google Maps link (google.com/maps/…, maps.google.com/…). */
export function isGoogleMapsLink(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      GOOGLE_MAPS_HOST.test(u.hostname) &&
      (u.hostname.startsWith("maps.") || u.pathname.startsWith("/maps"))
    );
  } catch {
    return false;
  }
}

/**
 * The point a pasted map link or coordinates point at. Google Maps place links
 * carry the place itself as !3d<lat>!4d<lon> and the camera as @<lat>,<lon>;
 * the place wins. Also reads ?q= / ?query= / ?ll= coordinates and Apple Maps links.
 */
export function parseMapLink(input: string): LatLon | null {
  const typed = parseLatLon(input);
  if (typed) return typed;
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const text = decodeURIComponent(u.pathname + u.search + u.hash);
  const place = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (place) return validPoint(Number(place[1]), Number(place[2]));
  for (const key of ["q", "query", "ll", "destination"]) {
    const value = u.searchParams.get(key);
    const point = value ? parseLatLon(value) : null;
    if (point) return point;
  }
  const camera = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (camera) return validPoint(Number(camera[1]), Number(camera[2]));
  return null;
}

export type PlaceLinkKind = "website" | "google-maps" | "apple-maps" | "amap" | "tickets" | "reserve" | "source";

export interface PlaceLink {
  kind: PlaceLinkKind;
  label: string;
  url: string;
}

export interface PlaceLinkInput {
  title: string;
  cityName: string;
  countryIso?: string | null;
  mapsQuery?: string | null;
  address?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** Where the idea came from (a video, an article). */
  url?: string | null;
  website?: string | null;
  ticketUrl?: string | null;
  reserveUrl?: string | null;
  /** A Google Maps link someone shared; used as is because it's the most exact pin. */
  mapsUrl?: string | null;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

/**
 * The links an activity shows, in a fixed order: website, tickets, reserve,
 * maps, then the source. Google Maps links need no API key (Maps URLs);
 * China stops also get Apple Maps and, with a pin, Amap, since Google Maps is
 * blocked there without a VPN.
 */
export function placeLinks(p: PlaceLinkInput): PlaceLink[] {
  const links: PlaceLink[] = [];
  const seen = new Set<string>();
  const add = (kind: PlaceLinkKind, label: string, url: string | null | undefined) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ kind, label, url });
  };
  add("website", "Website", p.website);
  add("tickets", "Tickets", p.ticketUrl);
  add("reserve", "Reserve", p.reserveUrl);

  const query = p.mapsQuery?.trim() || [p.title, p.address || p.cityName].filter(Boolean).join(", ");
  const pinned = p.lat != null && p.lon != null;
  add("google-maps", "Google Maps", p.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`);
  if (p.countryIso === "CN") {
    const apple = new URLSearchParams({ q: p.title });
    if (pinned) apple.set("ll", `${p.lat},${p.lon}`);
    else apple.set("q", query);
    add("apple-maps", "Apple Maps", `https://maps.apple.com/?${apple.toString()}`);
    if (pinned) {
      const amap = new URLSearchParams({ position: `${p.lon},${p.lat}`, name: p.title, src: "trippr", coordinate: "wgs84", callnative: "1" });
      add("amap", "Amap", `https://uri.amap.com/marker?${amap.toString()}`);
    }
  }
  if (p.url && p.url !== p.website && p.url !== p.ticketUrl && p.url !== p.reserveUrl) {
    add("source", hostOf(p.url) ? `Source · ${hostOf(p.url)}` : "Source", p.url);
  }
  return links;
}
