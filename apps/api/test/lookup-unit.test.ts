/**
 * The lookup's safety checks as pure functions: no database, no network.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { checkLookup, collectToolUrls, findPlace, type FinderDeps, type LookupInput, type LookupResult } from "../src/services/inbox/lookup";

const raw = (over: Partial<LookupResult> = {}): LookupResult => ({
  placeName: "teamLab Planets TOKYO",
  address: "6-1-16 Toyosu, Koto City, Tokyo",
  cityCode: "TYO",
  website: null,
  ticketUrl: null,
  reserveUrl: null,
  eventDate: null,
  confidence: "high",
  evidence: [],
  seenUrls: [],
  ...over,
});

const known = new Set(["TYO", "OSA"]);

describe("collectToolUrls", () => {
  it("reads URLs from web search results, fetched pages and search citations, and nothing else", () => {
    const content = [
      { type: "text", text: "I'll look for it.", citations: null },
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "teamlab planets" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srv_1",
        content: [
          { type: "web_search_result", url: "https://www.teamlab.art/e/planets/", title: "teamLab Planets", encrypted_content: "x", page_age: null },
          { type: "web_search_result", url: "https://www.klook.com/activity/1/", title: "Klook", encrypted_content: "y", page_age: null },
        ],
      },
      { type: "web_search_tool_result", tool_use_id: "srv_2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
      {
        type: "web_fetch_tool_result",
        tool_use_id: "srv_3",
        content: {
          type: "web_fetch_result",
          url: "https://www.teamlab.art/e/planets/",
          retrieved_at: null,
          content: {
            type: "document",
            title: null,
            citations: null,
            source: { type: "text", media_type: "text/plain", data: "Tickets: https://ticket.teamlab.art/planets/ — see you!" },
          },
        },
      },
      {
        type: "text",
        text: "It is in Toyosu.",
        citations: [{ type: "web_search_result_location", url: "https://en.wikipedia.org/wiki/TeamLab_Planets", title: "w", cited_text: "c", encrypted_index: "e" }],
      },
      { type: "tool_use", id: "tu_1", name: "report_place", input: { website: "https://made-up.example.com/" } },
    ] as unknown as Anthropic.Beta.BetaContentBlock[];
    expect(collectToolUrls(content).sort()).toEqual(
      [
        "https://en.wikipedia.org/wiki/TeamLab_Planets",
        "https://ticket.teamlab.art/planets/",
        "https://www.klook.com/activity/1/",
        "https://www.teamlab.art/e/planets/",
      ].sort(),
    );
  });
});

describe("checkLookup", () => {
  it("keeps links seen in tool results or in the message", () => {
    const checked = checkLookup(
      raw({
        website: "https://www.teamlab.art/",
        ticketUrl: "https://ticket.teamlab.art/planets/",
        reserveUrl: "https://www.tablecheck.com/shops/x/reserve",
        seenUrls: ["https://www.teamlab.art/e/planets/", "https://ticket.teamlab.art/planets/"],
      }),
      { messageUrls: ["https://www.tablecheck.com/shops/x/reserve"], knownCities: known },
    );
    expect(checked).toMatchObject({
      website: "https://www.teamlab.art/",
      ticketUrl: "https://ticket.teamlab.art/planets/",
      reserveUrl: "https://www.tablecheck.com/shops/x/reserve",
      dropped: [],
    });
  });

  it("drops links nobody saw, non-https links and private hosts", () => {
    const checked = checkLookup(
      raw({
        website: "https://teamlab-official.example.com/",
        ticketUrl: "http://ticket.teamlab.art/planets/",
        reserveUrl: "https://192.168.0.10/reserve",
        seenUrls: ["http://ticket.teamlab.art/planets/", "https://192.168.0.10/reserve"],
      }),
      { messageUrls: [], knownCities: known },
    );
    expect(checked).toMatchObject({ website: null, ticketUrl: null, reserveUrl: null });
    expect(checked.dropped).toHaveLength(3);
  });

  it("checks city codes, dates, lengths and confidence, and ignores fields it doesn't know", () => {
    const checked = checkLookup(
      { ...raw({ cityCode: "zzz", eventDate: "2027-02-30", placeName: `  ${"x".repeat(300)}\u0000 `, evidence: ["a", "", "b"] }), lat: 1, lon: 2 } as LookupResult,
      { messageUrls: [], knownCities: known },
    );
    expect(checked.cityCode).toBeNull();
    expect(checked.eventDate).toBeNull();
    expect(checked.placeName).toHaveLength(120);
    expect(checked.evidence).toEqual(["a", "b"]);
    expect(checked).not.toHaveProperty("lat");
    expect(checkLookup(raw({ cityCode: "osa", eventDate: "2027-05-15" }), { messageUrls: [], knownCities: known })).toMatchObject({
      cityCode: "OSA",
      eventDate: "2027-05-15",
    });
    expect(checkLookup(raw({ placeName: null, confidence: "high" }), { messageUrls: [], knownCities: known }).confidence).toBe("low");
  });
});

describe("findPlace", () => {
  const tokyo = { code: "TYO", name: "Tokyo", lat: 35.6812, lon: 139.7671, countryIso: "JP", countryName: "Japan" };
  const input: LookupInput = {
    kind: "activity",
    title: "teamLab Planets",
    city: { code: "TYO", name: "Tokyo", countryName: "Japan" },
    routeCities: [],
    link: { url: "https://www.tiktok.com/@a/video/1", kind: "social", title: null, author: null },
    note: null,
    message: "",
  };
  const deps = (answer: LookupResult | null, point: { lat: number; lon: number; address: string } | null) => {
    const asked: string[] = [];
    const d = {
      lookup: { name: "fake", lookup: async () => answer },
      places: {
        enabled: true,
        find: async (text: string) => {
          asked.push(text);
          return point ? { ...point, osmId: null } : null;
        },
      },
      repos: { cities: { get: async (code: string) => (code === "TYO" ? tokyo : null) } },
    } as unknown as FinderDeps;
    return { d, asked };
  };

  it("pins from the geocoder, never from the model, and only 'placed' when confident", async () => {
    const answer = { ...raw(), lat: 1, lon: 2 } as LookupResult;
    const { d, asked } = deps(answer, { lat: 35.649, lon: 139.79, address: "teamLab Planets TOKYO, Toyosu, Tokyo" });
    const out = await findPlace(d, input, { messageUrls: [], knownCities: known });
    expect(out).toMatchObject({ state: "done", cityCode: "TYO", place: { lat: 35.649, lon: 139.79, placeStatus: "placed" } });
    expect(asked[0]).toBe("teamLab Planets TOKYO, 6-1-16 Toyosu, Koto City, Tokyo");

    const unsure = deps(raw({ confidence: "medium" }), { lat: 35.649, lon: 139.79, address: "teamLab Planets TOKYO" });
    expect((await findPlace(unsure.d, input, { messageUrls: [], knownCities: known })).place?.placeStatus).toBe("check");

    const far = deps(raw(), { lat: 34.69, lon: 135.5, address: "teamLab Planets, Osaka" });
    expect((await findPlace(far.d, input, { messageUrls: [], knownCities: known })).place?.placeStatus).toBe("not_found");
  });

  it("fails when the place isn't identified, keeping the message's own links", async () => {
    const { d } = deps(null, null);
    const out = await findPlace(d, { ...input, link: { url: "https://maps.app.goo.gl/abc", kind: "google-maps", title: null, author: null } }, { messageUrls: [], knownCities: known });
    expect(out).toMatchObject({ state: "failed", place: { mapsUrl: "https://maps.app.goo.gl/abc" } });
  });
});
