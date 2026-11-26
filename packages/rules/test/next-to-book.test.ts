import { describe, expect, it } from "vitest";
import { nextToBook, type NextStop } from "../src";

const jp = { countryIso: "JP", countryName: "Japan", visaRule: null };
const stops: NextStop[] = [
  { id: "tyo", cityName: "Tokyo", nights: 4, arriveMode: "flight", ...jp },
  {
    id: "kyo",
    cityName: "Kyoto",
    nights: 3,
    arriveMode: "hsr",
    ...jp,
    planned: [{ id: "a", title: "Aoi Matsuri", when: { on: "2027-05-15" } }],
  },
  { id: "osa", cityName: "Osaka", nights: 2, arriveMode: "train", ...jp, stays: [{ hotelId: "h", name: "Hotel", status: "booked", arrive: "2027-05-17", depart: "2027-05-19" }] },
];

describe("nextToBook", () => {
  it("puts the flight home and the first flight above hotels", () => {
    const items = nextToBook({ startDate: "2027-05-10", stops });
    expect(items[0]).toMatchObject({ kind: "home", title: "Flight home", date: "2027-05-19" });
    expect(items[1]).toMatchObject({ kind: "transport", stopId: "tyo", title: "Flight to Tokyo" });
  });

  it("pushes a hotel up when a fixed-date event is on, and leaves booked ones out", () => {
    const items = nextToBook({ startDate: "2027-05-10", stops });
    const kyoto = items.find((i) => i.kind === "stay" && i.stopId === "kyo")!;
    expect(kyoto.reasons[0]).toContain("Aoi Matsuri");
    expect(items.some((i) => i.kind === "stay" && i.stopId === "osa")).toBe(false);
    expect(items.findIndex((i) => i === kyoto)).toBeLessThan(items.findIndex((i) => i.kind === "stay" && i.stopId === "tyo"));
  });

  it("listens to the fare tracker and drops the home flight once it's booked", () => {
    const items = nextToBook({
      startDate: "2027-05-10",
      stops,
      home: [{ id: "h", status: "booked", departAt: "2027-05-19T10:00+09:00" }],
      fareVerdicts: { tyo: "buy" },
    });
    expect(items[0]).toMatchObject({ stopId: "tyo" });
    expect(items[0]!.reasons[0]).toContain("good time to buy");
    expect(items.some((i) => i.kind === "home")).toBe(false);
  });
});

describe("cancellation deadlines", () => {
  it("puts a booking whose free cancellation ends soon at the top", () => {
    const withDeadline: NextStop[] = stops.map((s) =>
      s.id === "osa" ? { ...s, stays: [{ hotelId: "h", name: "Hotel Kansai", status: "booked", arrive: "2027-05-17", depart: "2027-05-19", freeCancelUntil: "2027-03-05" }] } : s,
    );
    const items = nextToBook({ startDate: "2027-05-10", stops: withDeadline, today: "2027-03-01" });
    expect(items[0]).toMatchObject({ kind: "deadline", stopId: "osa", title: "Free cancellation on Hotel Kansai ends", date: "2027-03-05" });
    expect(items[0]!.reasons[0]).toBe("4 days left to cancel for free, then it's final");
    // Far off, or already past: not a deadline item.
    expect(nextToBook({ startDate: "2027-05-10", stops: withDeadline, today: "2027-01-01" }).some((i) => i.kind === "deadline")).toBe(false);
    expect(nextToBook({ startDate: "2027-05-10", stops: withDeadline, today: "2027-03-06" }).some((i) => i.kind === "deadline")).toBe(false);
  });
});
