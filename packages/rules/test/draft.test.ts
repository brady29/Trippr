import { describe, expect, it } from "vitest";
import { draftRoute, fixesFor, runChecks, type RuleStop } from "../src";

describe("draftRoute", () => {
  it("puts must-dos in date order and arrives the day before each one", () => {
    const draft = draftRoute(
      "2027-05-10",
      [
        { cityCode: "KYO", title: "Aoi Matsuri", from: "2027-05-15", to: "2027-05-15" },
        { cityCode: "TYO", title: "Sumo, day 1", from: "2027-05-11", to: "2027-05-11" },
        { cityCode: "HKG", title: "Happy Valley races", from: "2027-05-19", to: "2027-05-19" },
      ],
      "2027-05-22",
    );
    expect(draft.stops.map((s) => [s.cityCode, s.nights])).toEqual([
      ["TYO", 4],
      ["KYO", 4],
      ["HKG", 4],
    ]);
    expect(draft.returnDate).toBe("2027-05-22");
    expect(draft.missed).toEqual([]);
  });

  it("joins must-dos in the same city and leaves out the ones outside the dates", () => {
    const draft = draftRoute(
      "2027-05-10",
      [
        { cityCode: "TYO", title: "A", from: "2027-05-11", to: "2027-05-11" },
        { cityCode: "TYO", title: "B", from: "2027-05-13", to: "2027-05-14" },
        { cityCode: "OSA", title: "Too late", from: "2027-06-30", to: "2027-06-30" },
        { cityCode: "OSA", title: "Too early", from: "2027-05-01", to: "2027-05-02" },
      ],
      "2027-05-20",
    );
    expect(draft.stops).toHaveLength(1);
    expect(draft.stops[0]).toMatchObject({ cityCode: "TYO", nights: 10 });
    expect(draft.missed.map((m) => m.title).sort()).toEqual(["Too early", "Too late"]);
  });

  it("gives the last stop two nights past its must-do when there's no latest return", () => {
    const draft = draftRoute("2027-05-10", [{ cityCode: "TYO", title: "A", from: "2027-05-12", to: "2027-05-12" }]);
    expect(draft.returnDate).toBe("2027-05-14");
  });
});

describe("the latest return", () => {
  const jp = { countryIso: "JP", countryName: "Japan", visaRule: null };
  const stops: RuleStop[] = [
    { id: "a", cityName: "Tokyo", nights: 5, ...jp },
    { id: "b", cityName: "Osaka", nights: 4, ...jp },
  ];

  it("flags a home date past the window and finds nights to take off", () => {
    const check = runChecks("2027-05-10", stops, [], "2027-05-17").checks.find((c) => c.kind === "return-window")!;
    expect(check).toMatchObject({ level: "error" });
    expect(check.title).toContain("2 days after your latest return");
    const fixes = fixesFor("2027-05-10", stops, check, [], "2027-05-17");
    expect(fixes[0]!.label).toMatch(/^Take 2 nights from (Tokyo|Osaka)$/);
    expect(runChecks("2027-05-10", stops, [], "2027-05-19").checks.some((c) => c.kind === "return-window")).toBe(false);
  });
});
