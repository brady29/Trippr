import { describe, expect, it } from "vitest";
import { buildItinerary, localInstant, tzOffsetMinutes, type ItineraryStopInput } from "../src/itinerary";

const stop = (over: Partial<ItineraryStopInput> & Pick<ItineraryStopInput, "id" | "arrive" | "nights">): ItineraryStopInput => ({
  depart: "",
  arriveMode: "flight",
  city: { code: "TYO", name: "Tokyo", tz: "Asia/Tokyo" },
  planned: [],
  legs: [],
  stays: [],
  ...over,
});

const tokyo = stop({
  id: "s1",
  arrive: "2027-05-09",
  depart: "2027-05-12",
  nights: 3,
  stays: [{ status: "booked", hotel: { id: "h1", name: "Hotel Gracery" } }],
  legs: [
    {
      id: "l1",
      mode: "flight",
      from: { name: "Toronto Pearson" },
      to: { name: "Haneda" },
      number: "AC1",
      departAt: "2027-05-08T13:00-04:00",
      arriveAt: "2027-05-09T15:30+09:00",
    },
  ],
  planned: [
    { id: "a1", title: "Shibuya Sky", day: 1, startTime: "14:00", durationMin: 90 },
    { id: "a2", title: "Tsukiji breakfast", day: 2, startTime: "07:30" },
    { id: "a3", title: "Weekend flea market", day: 2, when: { weekdays: [0, 6] } },
    { id: "a4", title: "Sumo", day: 3, when: { on: "2027-05-20" } },
    { id: "a5", title: "Arcade night", day: null },
    { id: "a6", title: "teamLab", day: 5 },
  ],
});

const osaka = stop({
  id: "s2",
  arrive: "2027-05-12",
  depart: "2027-05-14",
  nights: 2,
  arriveMode: "hsr",
  city: { code: "OSA", name: "Osaka", tz: "Asia/Tokyo" },
  legs: [
    { id: "l2", mode: "hsr", from: { name: "Tokyo" }, to: { name: "Shin-Osaka" }, number: "Nozomi 21", departAt: "2027-05-12T09:00+09:00", arriveAt: "2027-05-12T11:30+09:00" },
  ],
  planned: [{ id: "b1", title: "Dotonbori", day: 1, startTime: "10:30", durationMin: 60 }],
});

describe("itinerary", () => {
  const it9 = buildItinerary([tokyo, osaka]);

  it("lists every day from the first flight to the day you leave the last stop", () => {
    expect(it9.days.map((d) => d.date)).toEqual(["2027-05-08", "2027-05-09", "2027-05-10", "2027-05-11", "2027-05-12", "2027-05-13", "2027-05-14"]);
    expect(it9.days.map((d) => d.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("puts each day at the stop you sleep at, with its hotel", () => {
    const d = it9.days.find((x) => x.date === "2027-05-10")!;
    expect(d).toMatchObject({ stopId: "s1", cityName: "Tokyo", stopDay: 2, stay: { name: "Hotel Gracery", status: "booked" } });
    expect(it9.days.find((x) => x.date === "2027-05-14")!.stopId).toBeNull();
  });

  it("files legs under their local departure day and marks travel days", () => {
    expect(it9.days[0]!.legs.map((l) => l.id)).toEqual(["l1"]);
    expect(it9.days[0]!.kind).toBe("travel");
    expect(it9.days.find((d) => d.date === "2027-05-12")!.legs.map((l) => l.id)).toEqual(["l2"]);
  });

  it("flags an activity that overlaps a leg, counting time at the station", () => {
    const shibuya = it9.days.find((d) => d.date === "2027-05-09")!.items[0]!;
    // Lands 15:30; 14:00 to 15:30 overlaps the flight itself.
    expect(shibuya.conflicts).toEqual([{ kind: "travel", message: expect.stringContaining("to Haneda") }]);
    const dotonbori = it9.days.find((d) => d.date === "2027-05-12")!.items[0]!;
    // The train gets in at 11:30 and the 30 minutes after it; 10:30 clashes.
    expect(dotonbori.conflicts[0]?.kind).toBe("travel");
  });

  it("flags weekdays it isn't on and fixed dates that don't match", () => {
    const day2 = it9.days.find((d) => d.date === "2027-05-10")!; // a Monday
    expect(day2.items.map((i) => i.title)).toEqual(["Tsukiji breakfast", "Weekend flea market"]);
    expect(day2.items[1]!.conflicts).toEqual([{ kind: "closed", message: "Usually only on Sun, Sat" }]);
    const day3 = it9.days.find((d) => d.date === "2027-05-11")!;
    expect(day3.items[0]!.conflicts).toEqual([{ kind: "wrong_date", message: "Happens on May 20, not this day" }]);
  });

  it("keeps unscheduled items and items past the stop's end apart", () => {
    const s1 = it9.stops.find((s) => s.stopId === "s1")!;
    expect(s1.unscheduled.map((i) => i.title)).toEqual(["Arcade night"]);
    expect(s1.needsNewDay.map((i) => i.title)).toEqual(["teamLab"]);
    expect(s1.needsNewDay[0]!.conflicts[0]!.kind).toBe("outside_stop");
    expect(s1.days.map((d) => d.date)).toEqual(["2027-05-09", "2027-05-10", "2027-05-11"]);
  });

  it("calls a day with nothing planned free", () => {
    const empty = buildItinerary([stop({ id: "x", arrive: "2027-06-01", depart: "2027-06-03", nights: 2 })]);
    expect(empty.days.map((d) => d.kind)).toEqual(["travel", "free", "travel"]);
  });
});

describe("time zones", () => {
  it("knows offsets, including daylight saving", () => {
    expect(tzOffsetMinutes("Asia/Tokyo", "2027-05-10")).toBe(540);
    expect(tzOffsetMinutes("Asia/Kathmandu", "2027-05-10")).toBe(345);
    expect(tzOffsetMinutes("America/Toronto", "2027-07-01")).toBe(-240);
    expect(tzOffsetMinutes("America/Toronto", "2027-01-15")).toBe(-300);
    expect(tzOffsetMinutes("Not/AZone", "2027-01-15")).toBeNull();
  });

  it("turns a local time into an instant", () => {
    expect(new Date(localInstant("2027-05-10", "09:30", "Asia/Shanghai")!).toISOString()).toBe("2027-05-10T01:30:00.000Z");
  });
});
