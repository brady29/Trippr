/**
 * Links that reach the trip inbox: what kind of page each one is, and the
 * checks a link found by the place lookup has to pass before it is kept.
 * Pure functions, no network.
 */

export const LINK_KINDS = ["social", "google-maps", "ticket", "restaurant", "hotel", "transport", "article", "unknown"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** Hosts (and their subdomains) by kind. A path rule wins over the plain host list. */
const SOCIAL = ["tiktok.com", "instagram.com", "youtube.com", "youtu.be", "xiaohongshu.com", "xhslink.com", "douyin.com", "iesdouyin.com", "facebook.com", "fb.watch", "fb.com", "x.com", "twitter.com", "threads.net"];
const TICKET = ["klook.com", "kkday.com", "getyourguide.com", "viator.com", "ticketmaster.com", "ticketmaster.co.jp", "eplus.jp", "pia.jp", "interpark.com", "veltra.com", "tiqets.com", "headout.com"];
const RESTAURANT = ["tabelog.com", "opentable.com", "opentable.ca", "dianping.com", "catchtable.net", "catchtable.co.kr", "tablecheck.com", "resy.com", "exploretock.com", "hotpepper.jp", "gnavi.co.jp", "omakase.in", "tableall.com", "pocket-concierge.jp"];
const HOTEL = ["booking.com", "agoda.com", "hotels.com", "expedia.com", "expedia.ca", "airbnb.com", "airbnb.ca", "marriott.com", "hilton.com", "hyatt.com", "ihg.com", "accor.com", "all.accor.com", "jalan.net", "travel.rakuten.co.jp", "hostelworld.com", "trivago.com", "ctrip.com"];
const TRANSPORT = ["aircanada.com", "ana.co.jp", "jal.co.jp", "united.com", "delta.com", "cathaypacific.com", "koreanair.com", "flyasiana.com", "singaporeair.com", "airasia.com", "flyscoot.com", "jetstar.com", "vietnamairlines.com", "12306.cn", "smart-ex.jp", "eki-net.com", "jrpass.com", "japanrailpass.net", "letskorail.com", "korail.com", "thsrc.com.tw", "12go.asia", "rome2rio.com", "skyscanner.com", "skyscanner.ca", "flightaware.com", "flighty.com", "kayak.com", "kayak.ca", "google.com/travel", "hyperdia.com", "navitime.co.jp"];

const hostMatches = (host: string, list: string[]) => list.some((h) => !h.includes("/") && (host === h || host.endsWith(`.${h}`)));

function parse(url: string): URL | null {
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

const GOOGLE_HOST = /^(www\.|maps\.)?google\.[a-z.]{2,6}$/;

/** What kind of page a link is, from its host and path only. */
export function classifyLink(url: string): LinkKind {
  const u = parse(url);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return "unknown";
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const path = u.pathname.toLowerCase();

  if (host === "maps.app.goo.gl" || (host === "goo.gl" && path.startsWith("/maps"))) return "google-maps";
  if (GOOGLE_HOST.test(u.hostname.toLowerCase())) {
    if (u.hostname.toLowerCase().startsWith("maps.") || path.startsWith("/maps")) return "google-maps";
    if (path.startsWith("/travel")) return "transport";
    return "article";
  }
  if (hostMatches(host, SOCIAL)) return "social";

  // Trip.com sells everything; the path says which part.
  if (host === "trip.com" || host.endsWith(".trip.com")) {
    if (/\/(things-to-do|attractions?|travel-guide\/attraction|tours?|activities)\b/.test(path)) return "ticket";
    if (/\/(hotels?|hotel)\b/.test(path)) return "hotel";
    if (/\/(flights?|trains?|buses|car-?hire)\b/.test(path)) return "transport";
    return "article";
  }
  if (hostMatches(host, TICKET)) return "ticket";
  if (hostMatches(host, RESTAURANT)) return "restaurant";
  if (hostMatches(host, HOTEL)) return "hotel";
  if (hostMatches(host, TRANSPORT)) return "transport";
  return "article";
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True for hosts that are an IP address, localhost or a single label (an intranet name). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (IPV4.test(h) || h.startsWith("[") || h.includes(":")) return true;
  return !h.includes(".");
}

/**
 * A link the app may show: https only, a public host name (no IP addresses,
 * localhost or intranet names), no user name or password, a normal port, at
 * most `maxLength` characters. Anything else is null.
 */
export function safeWebUrl(raw: string | null | undefined, maxLength = 500): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > maxLength || /\s/.test(trimmed)) return null;
  const u = parse(trimmed);
  if (!u || u.protocol !== "https:") return null;
  if (u.username || u.password || (u.port && u.port !== "443")) return null;
  if (isPrivateHost(u.hostname)) return null;
  const out = u.toString();
  return out.length <= maxLength ? out : null;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]}]+/gi;

/** Every http(s) URL written in a piece of text, without trailing punctuation. */
export function urlsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set((text.match(URL_IN_TEXT) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))];
}

/** host + path, for comparing links: lower-case host without www., no trailing slash, no fragment or query. */
function key(url: string): { host: string; path: string } | null {
  const u = parse(url);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  return { host: u.hostname.toLowerCase().replace(/^(www|m)\./, ""), path: path.replace(/\/+$/, "") || "" };
}

/**
 * Whether a link the lookup returned is backed by what it actually saw: the
 * same page appears among `seen` (search and fetch results, the original
 * message), or it is a parent page (for example the home page) of one that does.
 */
export function urlBackedBy(candidate: string, seen: Iterable<string>): boolean {
  const c = key(candidate);
  if (!c) return false;
  for (const s of seen) {
    const k = key(s);
    if (!k || k.host !== c.host) continue;
    if (k.path === c.path || c.path === "" || k.path.startsWith(`${c.path}/`)) return true;
  }
  return false;
}

const words = (s: string) =>
  new Set(
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 || /\P{ASCII}/u.test(w)),
  );

/**
 * A loose name check between the place the lookup named and what the
 * geocoder found: at least one real word in common, not counting `ignore`
 * (the city and country names, which every address in the city contains).
 * Names in scripts without spaces (Chinese, Japanese) match when one contains the other.
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined, ignore: (string | null | undefined)[] = []): boolean {
  if (!a || !b) return false;
  const lowA = a.trim().toLowerCase();
  const lowB = b.trim().toLowerCase();
  if (lowA && lowB && (lowA.includes(lowB) || lowB.includes(lowA))) return true;
  const skip = new Set(ignore.flatMap((i) => (i ? [...words(i)] : [])));
  const wb = words(b);
  for (const w of words(a)) if (!skip.has(w) && wb.has(w)) return true;
  return false;
}
