import type { RouteView } from "@trippr/contracts";
import { buildItinerary } from "@trippr/rules";
import { describe, expect, it } from "vitest";
import { icsEscape, icsFold, itineraryToIcs, routeToIcs, type ItineraryIcsOptions } from "../src/services/export";

// Pure rendering: no database needed.

const hub = (name: string, code: string) => ({ kind: "airport", id: `hub-${code}`, code, name, lat: 0, lon: 0, cityCode: code, cityName: name });

function sampleView(): RouteView {
  const stops = [
    {
      id: "st_bj",
      order: 0,
      nights: 3,
      arriveMode: "flight",
      arrive: "2027-05-15",
      depart: "2027-05-18",
      city: { code: "BJS", name: "Beijing", lat: 39.9, lon: 116.4, countryIso: "CN", countryName: "China", tz: "Asia/Shanghai" },
      country: { iso: "CN", name: "China" },
      planned: [],
      legs: [
        {
          id: "lg_1",
          seq: 0,
          mode: "flight",
          from: hub("Vancouver", "YVR"),
          to: hub("Beijing Capital", "PEK"),
          operator: "Air China",
          number: "CA992",
          departAt: "2027-05-14T13:05-07:00",
          arriveAt: "2027-05-15T16:30+08:00",
          status: "booked",
        },
      ],
      stays: [{ status: "booked", rooms: 1, hotel: { id: "h_bj", name: "Hutong House, Beijing; Old Town", url: null } }],
    },
    {
      id: "st_ty",
      order: 1,
      nights: 4,
      arriveMode: "flight",
      arrive: "2027-05-18",
      depart: "2027-05-22",
      city: { code: "TYO", name: "Tokyo", lat: 35.7, lon: 139.7, countryIso: "JP", countryName: "Japan", tz: "Asia/Tokyo" },
      country: { iso: "JP", name: "Japan" },
      planned: [
        { id: "ac_sky", title: "Shibuya Sky at sunset", day: 2, startTime: "18:30", durationMin: 90 },
        { id: "ac_market", title: "Tsukiji outer market", day: 3, startTime: null, durationMin: null },
        { id: "ac_later", title: "Not on a day yet", day: null },
      ],
      legs: [
        {
          id: "lg_2",
          seq: 0,
          mode: "flight",
          from: hub("Beijing Capital", "PEK"),
          to: hub("Tokyo Haneda", "HND"),
          operator: "ANA",
          number: "NH964",
          departAt: "2027-05-18T08:05+08:00",
          arriveAt: "2027-05-18T12:30+09:00",
          status: "held",
        },
      ],
      stays: [],
    },
  ];
  return {
    route: { id: "rt_main", tripId: "trip_1", name: "Main", tags: [], isCurrent: true, version: 1, createdAt: "2026-01-01T00:00:00Z" },
    trip: { id: "trip_1", name: "Asia 2027", startDate: "2027-05-14" },
    role: "editor",
    stops,
  } as unknown as RouteView;
}

const STAMP = new Date("2026-11-19T12:00:00Z");
const refs = new Map([["lg_2", { bookingRef: "ABC123", seat: "12A" }]]);

function render(options: Partial<ItineraryIcsOptions> = {}, view = sampleView()) {
  return itineraryToIcs(view, buildItinerary(view.stops), { webUrl: "https://trippr.example/", stamp: STAMP, ...options });
}

/** Undo line folding so assertions don't depend on where a line was cut. */
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

/** The unfolded lines of the event with this UID. */
function event(ics: string, uid: string): string[] {
  const lines = unfold(ics).split("\r\n");
  const at = lines.indexOf(`UID:${uid}`);
  expect(at, `event ${uid}`).toBeGreaterThan(-1);
  const start = lines.lastIndexOf("BEGIN:VEVENT", at);
  const end = lines.indexOf("END:VEVENT", at);
  return lines.slice(start, end + 1);
}

describe("itineraryToIcs", () => {
  it("converts legs to UTC from their stored offsets", () => {
    const ics = render();
    expect(event(ics, "leg-lg_1@trippr")).toEqual(
      expect.arrayContaining(["DTSTART:20270514T200500Z", "DTEND:20270515T083000Z", "STATUS:CONFIRMED"]),
    );
    const tokyoLeg = event(ics, "leg-lg_2@trippr");
    expect(tokyoLeg).toEqual(expect.arrayContaining(["DTSTART:20270518T000500Z", "DTEND:20270518T033000Z", "STATUS:TENTATIVE"]));
    expect(tokyoLeg.find((l) => l.startsWith("SUMMARY:"))).toBe("SUMMARY:Flight ANA NH964: Beijing Capital → Tokyo Haneda");
    expect(tokyoLeg.find((l) => l.startsWith("DESCRIPTION:"))).toContain("Departs 08:05 (UTC+08:00) local time");
  });

  it("falls back to an all-day event for a leg without a time and offset", () => {
    const view = sampleView();
    view.stops[1]!.legs[0]!.departAt = "2027-05-18";
    view.stops[1]!.legs[0]!.arriveAt = null;
    const leg = event(render({}, view), "leg-lg_2@trippr");
    expect(leg).toEqual(expect.arrayContaining(["DTSTART;VALUE=DATE:20270518", "DTEND;VALUE=DATE:20270519"]));
  });

  it("shows stays as all-day events from check-in to check-out", () => {
    const ics = render();
    const beijing = event(ics, "stay-st_bj@trippr");
    expect(beijing).toEqual(expect.arrayContaining(["DTSTART;VALUE=DATE:20270515", "DTEND;VALUE=DATE:20270518", "STATUS:CONFIRMED"]));
    const tokyo = event(ics, "stay-st_ty@trippr");
    expect(tokyo).toEqual(
      expect.arrayContaining(["DTSTART;VALUE=DATE:20270518", "DTEND;VALUE=DATE:20270522", "SUMMARY:Tokyo (4 nights)", "STATUS:TENTATIVE"]),
    );
  });

  it("times activities in the city's time zone (Asia/Tokyo) and makes untimed ones all-day", () => {
    const ics = render();
    // Day 2 in Tokyo is 19 May; 18:30 JST is 09:30 UTC, and 90 minutes later is 11:00.
    const sky = event(ics, "act-st_ty-ac_sky@trippr");
    expect(sky).toEqual(expect.arrayContaining(["DTSTART:20270519T093000Z", "DTEND:20270519T110000Z", "SUMMARY:Shibuya Sky at sunset"]));
    const market = event(ics, "act-st_ty-ac_market@trippr");
    expect(market).toEqual(expect.arrayContaining(["DTSTART;VALUE=DATE:20270520", "DTEND;VALUE=DATE:20270521"]));
    expect(ics).not.toContain("ac_later");
  });

  it("uses 60 minutes when an activity has a start time but no length", () => {
    const view = sampleView();
    view.stops[1]!.planned[0]!.durationMin = null;
    expect(event(render({}, view), "act-st_ty-ac_sky@trippr")).toContain("DTEND:20270519T103000Z");
  });

  it("links every event back to Trippr and activities to Google Maps", () => {
    const ics = render({ places: new Map([["ac_sky", { address: "2-24-12 Shibuya, Tokyo", website: "https://www.shibuya-scramble-square.com/sky/" }]]) });
    const sky = event(ics, "act-st_ty-ac_sky@trippr");
    const description = sky.find((l) => l.startsWith("DESCRIPTION:"))!;
    expect(description).toContain("Google Maps: https://www.google.com/maps/search/?api=1&query=");
    expect(description).toContain("Website: https://www.shibuya-scramble-square.com/sky/");
    expect(description).toContain("Open in Trippr: https://trippr.example/trips/trip_1/itinerary");
    expect(sky).toContain("URL:https://trippr.example/trips/trip_1/itinerary");
    expect(sky).toContain("LOCATION:2-24-12 Shibuya\\, Tokyo");
    for (const uid of ["leg-lg_1@trippr", "stay-st_bj@trippr", "act-st_ty-ac_market@trippr"]) {
      expect(event(ics, uid)).toContain("URL:https://trippr.example/trips/trip_1/itinerary");
    }
  });

  it("keeps UIDs stable between builds and stamps each event", () => {
    const uids = (ics: string) => unfold(ics).split("\r\n").filter((l) => l.startsWith("UID:"));
    const a = render();
    const b = render({ stamp: new Date("2026-12-01T00:00:00Z") });
    expect(uids(a)).toEqual(uids(b));
    expect(uids(a)).toHaveLength(6);
    expect(new Set(uids(a)).size).toBe(6);
    expect(a.match(/^BEGIN:VEVENT\r$/gm)).toHaveLength(6);
    expect(event(a, "leg-lg_1@trippr")).toEqual(expect.arrayContaining(["DTSTAMP:20261119T120000Z", "LAST-MODIFIED:20261119T120000Z"]));
    expect(event(b, "leg-lg_1@trippr")).toContain("LAST-MODIFIED:20261201T000000Z");
  });

  it("escapes text, folds long lines at 75 octets and uses CRLF", () => {
    const view = sampleView();
    view.stops[1]!.planned[0]!.title = "東京スカイツリー展望デッキ、夜景と夕焼けを一緒に楽しむ特別なひととき 🌇 with friends; bring cash, really";
    const ics = render({}, view);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    // Folding never cuts a character in half.
    expect(ics).not.toContain("�");
    expect(unfold(ics)).toContain("bring cash\\, really");
    expect(unfold(ics)).toContain("with friends\\; bring");
    expect(unfold(ics)).toContain("🌇");
    expect(event(ics, "stay-st_bj@trippr")).toContain("SUMMARY:Beijing: Hutong House\\, Beijing\\; Old Town");
  });

  it("leaves booking references out unless they are allowed", () => {
    expect(unfold(render())).not.toContain("ABC123");
    expect(unfold(render({ legRefs: refs, includePrivate: false }))).not.toContain("ABC123");
    expect(unfold(render({ legRefs: refs }))).not.toContain("ABC123");
    const allowed = event(render({ legRefs: refs, includePrivate: true }), "leg-lg_2@trippr").find((l) => l.startsWith("DESCRIPTION:"))!;
    expect(allowed).toContain("Booking reference: ABC123");
    expect(allowed).toContain("Seat: 12A");
  });
});

describe("ICS helpers", () => {
  it("escapes backslashes, semicolons, commas and newlines", () => {
    expect(icsEscape("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
  });

  it("folds at 75 octets with a leading space on each continuation", () => {
    const folded = icsFold(`DESCRIPTION:${"x".repeat(200)}`);
    const parts = folded.split("\r\n");
    expect(parts[0]).toHaveLength(75);
    expect(parts.slice(1).every((p) => p.startsWith(" ") && p.length <= 75)).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(`DESCRIPTION:${"x".repeat(200)}`);
  });

  it("keeps the route download unchanged in shape", () => {
    const ics = routeToIcs(sampleView(), STAMP);
    expect(ics).toContain("PRODID:-//Trippr//Trip Graph//EN\r\n");
    expect(ics).toContain("UID:st_bj@trippr\r\nDTSTAMP:20261119T120000Z\r\nDTSTART;VALUE=DATE:20270515\r\n");
  });
});
