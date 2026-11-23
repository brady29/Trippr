import { describe, expect, it } from "vitest";
import { isCatalogueId, planAdoptions, titleKey, type CatalogueCandidate, type HandWrittenActivity } from "../src/catalogue";

describe("titleKey", () => {
  it("ignores case, punctuation, word order and articles", () => {
    expect(titleKey("Shibuya Sky")).toBe(titleKey("SHIBUYA  SKY!"));
    expect(titleKey("The Bund, Shanghai")).toBe(titleKey("Shanghai Bund"));
  });

  it("can drop the city's name", () => {
    expect(titleKey("teamLab Planets TOKYO", ["Tokyo"])).toBe("planets teamlab");
    expect(titleKey("Tokyo", ["Tokyo"])).toBe("");
  });

  it("keeps CJK names whole and normalises width", () => {
    expect(titleKey("ＴＯＫＹＯ Ｔｏｗｅｒ")).toBe("tokyo tower");
    expect(titleKey("渋谷スカイ")).toBe("渋谷スカイ");
    expect(titleKey("が")).not.toBe(titleKey("か")); // voicing marks are kept
    expect(titleKey("!!!")).toBe("");
  });
});

const act = (over: Partial<HandWrittenActivity> & { id: string; title: string }): HandWrittenActivity => ({
  cityCode: "TYO",
  cityName: "Tokyo",
  ...over,
});
const place = (over: Partial<CatalogueCandidate> & { id: string; names: string[] }): CatalogueCandidate => ({
  cityCode: "TYO",
  lat: 35.65,
  lon: 139.78,
  rank: 1,
  ...over,
});

describe("planAdoptions", () => {
  it("matches a hand-written activity to the place of the same name in the same city", () => {
    const result = planAdoptions(
      [act({ id: "act-teamlab", title: "teamLab Planets", mapsQuery: "teamLab Planets TOKYO" })],
      [place({ id: "cat-1", names: ["teamLab Planets TOKYO"] }), place({ id: "cat-2", names: ["Tokyo Tower"] })],
    );
    expect(result).toEqual([{ activityId: "act-teamlab", placeId: "cat-1" }]);
  });

  it("uses the Maps query as a second name", () => {
    expect(
      planAdoptions([act({ id: "a", title: "Sumo tournament", mapsQuery: "Ryogoku Kokugikan, Tokyo" })], [place({ id: "cat-1", names: ["Ryogoku Kokugikan"] })]),
    ).toEqual([{ activityId: "a", placeId: "cat-1" }]);
  });

  it("does not match partial names, other cities or different places", () => {
    expect(planAdoptions([act({ id: "a", title: "Chongqing hotpot" })], [place({ id: "cat-1", names: ["Chongqing Hotpot Restaurant No. 3"] })])).toEqual([]);
    expect(planAdoptions([act({ id: "a", title: "Shibuya Sky" })], [place({ id: "cat-1", cityCode: "OSA", names: ["Shibuya Sky"] })])).toEqual([]);
    expect(planAdoptions([act({ id: "a", title: "Tokyo" })], [place({ id: "cat-1", names: ["Tokyo Tower"] })])).toEqual([]);
  });

  it("checks a pin that is already set", () => {
    const near = place({ id: "cat-1", names: ["Meiji Shrine"], lat: 35.6764, lon: 139.6993 });
    const here = act({ id: "a", title: "Meiji Shrine", lat: 35.6765, lon: 139.6994 });
    const elsewhere = act({ id: "b", title: "Meiji Shrine", lat: 34.69, lon: 135.5 });
    expect(planAdoptions([here], [near])).toHaveLength(1);
    expect(planAdoptions([elsewhere], [near])).toEqual([]);
  });

  it("uses each place once and prefers the better rank", () => {
    const places = [place({ id: "cat-b", names: ["Senso-ji"], rank: 9 }), place({ id: "cat-a", names: ["Senso ji"], rank: 2 })];
    const result = planAdoptions([act({ id: "a1", title: "Senso-ji" }), act({ id: "a2", title: "SENSO JI" })], places);
    expect(result).toEqual([
      { activityId: "a1", placeId: "cat-a" },
      { activityId: "a2", placeId: "cat-b" },
    ]);
  });
});

describe("isCatalogueId", () => {
  it("tells catalogue ids from hand-written ones", () => {
    expect(isCatalogueId("cat-0123456789abcdef")).toBe(true);
    expect(isCatalogueId("act-teamlab")).toBe(false);
  });
});
