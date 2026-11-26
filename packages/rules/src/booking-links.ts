/**
 * Search links into the sites people actually book on, filled in with the
 * trip's cities, dates and group size. Nothing here talks to those sites;
 * it only builds URLs whose query formats were checked by hand.
 */

export type BookingProvider = "tripcom" | "google-flights" | "booking" | "airbnb" | "12go" | "klook" | "tripcom-trains" | "smartex" | "korail";

export interface BookingLink {
  provider: BookingProvider;
  label: string;
  url: string;
  /** One short line shown under the link, e.g. when tickets go on sale. */
  hint?: string;
}

export interface LinkCity {
  code: string;
  name: string;
  countryIso?: string | null;
}

export type LinkMode = "flight" | "hsr" | "train" | "road" | "boat" | "maglev" | "car" | "bus";

/** 12Go covers trains, buses and ferries across these countries. */
const TWELVE_GO = new Set(["TH", "VN", "KH", "LA", "MY", "SG", "ID", "PH", "MM", "JP", "KR", "TW", "CN", "HK", "MO", "IN", "LK", "NP"]);

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const qs = (params: Record<string, string | number | null | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

const people = (n: number | null | undefined) => Math.min(Math.max(Math.round(n ?? 1), 1), 9);

/** A date only when it looks like YYYY-MM-DD. */
const day = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);

export function flightLinks(from: LinkCity, to: LinkCity, date: string | null | undefined, travellers: number): BookingLink[] {
  const d = day(date);
  const n = people(travellers);
  const tripcom = `https://www.trip.com/flights/showfarefirst?${qs({
    dcity: from.code.toLowerCase(),
    acity: to.code.toLowerCase(),
    ddate: d,
    triptype: "ow",
    class: "y",
    quantity: n,
    locale: "en-US",
    curr: "CAD",
  })}`;
  const words = `Flights from ${from.name} to ${to.name}${d ? ` on ${d}` : ""} one way ${n} adult${n === 1 ? "" : "s"}`;
  return [
    { provider: "tripcom", label: "Trip.com", url: tripcom },
    { provider: "google-flights", label: "Google Flights", url: `https://www.google.com/travel/flights?${qs({ q: words, curr: "CAD" })}` },
  ];
}

/**
 * Flights to or from home. The trip's home city is free text ("Toronto"), so
 * either end may be a plain name; Trip.com needs city codes, so it is offered
 * only when both ends have one (a known city, or three letters like YTO).
 */
export function homeFlightLinks(from: LinkCity | string, to: LinkCity | string, date: string | null | undefined, travellers: number): BookingLink[] {
  const city = (c: LinkCity | string) => (typeof c === "string" ? { code: c, name: c } : c);
  const a = city(from);
  const b = city(to);
  const links = flightLinks(a, b, date, travellers);
  const coded = (c: LinkCity) => /^[A-Za-z]{3}$/.test(c.code);
  return coded(a) && coded(b) ? links : links.filter((l) => l.provider !== "tripcom");
}

export function groundLinks(mode: LinkMode, from: LinkCity, to: LinkCity, date: string | null | undefined, travellers: number): BookingLink[] {
  const d = day(date);
  const links: BookingLink[] = [];
  const both = (iso: string) => from.countryIso === iso && to.countryIso === iso;
  const rail = mode === "hsr" || mode === "train" || mode === "maglev";
  if (rail && both("CN")) {
    links.push({
      provider: "tripcom-trains",
      label: "Trip.com trains",
      url: "https://www.trip.com/trains/china/?locale=en-US&curr=CAD",
      hint: "China rail tickets go on sale 15 days before travel.",
    });
  }
  if (rail && both("JP")) {
    links.push({
      provider: "smartex",
      label: "SmartEX (Shinkansen)",
      url: "https://smart-ex.jp/en/",
      hint: "Tokaido, Sanyo and Kyushu Shinkansen. Seats open a month ahead.",
    });
  }
  if (rail && both("KR")) {
    links.push({ provider: "korail", label: "Korail", url: "https://www.letskorail.com/", hint: "KTX tickets open a month ahead." });
  }
  if (from.countryIso && to.countryIso && TWELVE_GO.has(from.countryIso) && TWELVE_GO.has(to.countryIso)) {
    links.push({
      provider: "12go",
      label: "12Go",
      url: `https://12go.asia/en/travel/${slug(from.name)}/${slug(to.name)}?${qs({ date: d, people: people(travellers) })}`,
    });
  }
  return links;
}

/** Where to look for tickets for one hop, by how you plan to travel. */
export function travelLinks(mode: LinkMode, from: LinkCity, to: LinkCity, date: string | null | undefined, travellers: number): BookingLink[] {
  if (mode === "flight") return flightLinks(from, to, date, travellers);
  if (mode === "car") return [];
  return groundLinks(mode, from, to, date, travellers);
}

export function hotelLinks(
  city: LinkCity,
  checkIn: string | null | undefined,
  checkOut: string | null | undefined,
  travellers: number,
  rooms?: number | null,
): BookingLink[] {
  const n = people(travellers);
  const r = Math.min(Math.max(rooms ?? Math.ceil(n / 2), 1), n);
  return [
    {
      provider: "booking",
      label: "Booking.com",
      url: `https://www.booking.com/searchresults.html?${qs({
        ss: `${city.name}`,
        checkin: day(checkIn),
        checkout: day(checkOut),
        group_adults: n,
        no_rooms: r,
        selected_currency: "CAD",
      })}`,
    },
  ];
}

/**
 * "Search Airbnb" and "Search hotels" for an Area (or a whole city), with the stop's dates and group size.
 * Plain keyword searches on the sites' own search pages: no scraping, no affiliate or tracking parameters, and nothing
 * about individual listings is read or shown by Trippr.
 */
export function stayLinks(
  place: { area?: string | null; city: LinkCity },
  checkIn: string | null | undefined,
  checkOut: string | null | undefined,
  travellers: number,
  rooms?: number | null,
): BookingLink[] {
  const n = people(travellers);
  const where = place.area ? `${place.area}, ${place.city.name}` : place.city.name;
  const what = place.area ? place.area : place.city.name;
  const airbnb = `https://www.airbnb.com/s/${encodeURIComponent(where.replace(/,\s*/g, "--"))}/homes?${qs({
    checkin: day(checkIn),
    checkout: day(checkOut),
    adults: n,
    currency: "CAD",
  })}`;
  const hotels = hotelLinks({ ...place.city, name: where }, checkIn, checkOut, n, rooms)[0]!;
  return [
    { provider: "airbnb", label: `Search Airbnb`, url: airbnb, hint: `Opens Airbnb's own search for ${what}.` },
    { ...hotels, label: "Search hotels" },
  ];
}

export function activityLinks(city: LinkCity, what?: string | null): BookingLink[] {
  const query = what ? `${what} ${city.name}` : city.name;
  return [{ provider: "klook", label: "Klook", url: `https://www.klook.com/en-CA/search/result/?${qs({ query })}` }];
}
