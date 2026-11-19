import { describe, expect, it } from "vitest";
import { distanceKm, formatDuration, landmassOf, possibleModes, railConnected, travelOptions, type PlaceFacts } from "../src/travel";

const place = (code: string, countryIso: string, lat: number, lon: number, has: Partial<Pick<PlaceFacts, "airport" | "hsr" | "rail">> = {}): PlaceFacts => ({
  code,
  name: code,
  countryIso,
  lat,
  lon,
  airport: has.airport ?? true,
  hsr: has.hsr ?? false,
  rail: has.rail ?? has.hsr ?? false,
});

const CKG = place("CKG", "CN", 29.563, 106.5516, { hsr: true });
const CAN = place("CAN", "CN", 23.1291, 113.2644, { hsr: true });
const CAN_SZX = place("SZX", "CN", 22.5431, 114.0579, { hsr: true });
const TYO = place("TYO", "JP", 35.6812, 139.7671, { hsr: true });
const BJS = place("BJS", "CN", 39.9042, 116.4074, { hsr: true });
const DPS = place("DPS", "ID", -8.65, 115.2167);
const LOP = place("LOP", "ID", -8.5833, 116.1167);
const CNX = place("CNX", "TH", 18.7883, 98.9853, { rail: true });
const CEI = place("CEI", "TH", 19.9105, 99.8406);

describe("distances and geography", () => {
  it("measures great-circle distance", () => {
    expect(Math.round(distanceKm(CKG, CAN))).toBeGreaterThan(950);
    expect(Math.round(distanceKm(CKG, CAN))).toBeLessThan(1050);
  });

  it("keeps islands apart and mainland Asia together", () => {
    expect(landmassOf(DPS)).not.toBe(landmassOf(LOP));
    expect(landmassOf(CNX)).toBe(landmassOf(CKG));
    expect(landmassOf(TYO)).not.toBe(landmassOf(BJS));
  });

  it("knows which rail networks connect", () => {
    expect(railConnected(CKG, CAN)).toBe(true);
    expect(railConnected(TYO, BJS)).toBe(false);
  });

  it("formats durations", () => {
    expect(formatDuration(65)).toBe("1 h 5 min");
    expect(formatDuration(120)).toBe("2 h");
    expect(formatDuration(45)).toBe("45 min");
  });
});

describe("travelOptions", () => {
  it("offers flight, high-speed rail, bus and car on the Chinese mainland", () => {
    const modes = possibleModes(CKG, CAN, distanceKm(CKG, CAN));
    expect(modes).toEqual(expect.arrayContaining(["flight", "hsr", "bus"]));
    // ~1,300 km of road is too far to recommend driving.
    expect(modes).not.toContain("car");
  });

  it("uses stored research over estimates, adding airport or station time", () => {
    const opts = travelOptions(CKG, CAN, [
      { mode: "hsr", minutes: 345, costCad: 90, source: "planner research" },
      { mode: "flight", minutes: 135, costCad: 120, source: "planner research" },
    ]);
    const hsr = opts.find((o) => o.mode === "hsr")!;
    expect(hsr).toMatchObject({ source: "stored", costPerPersonCad: 90, minutes: 395 });
    const flight = opts.find((o) => o.mode === "flight")!;
    expect(flight).toMatchObject({ source: "stored", costPerPersonCad: 120, minutes: 310 });
  });

  it("recommends the train for a short hop and only flights between Japan and China", () => {
    const short = travelOptions(CAN, CAN_SZX, []);
    expect(short[0]!.mode).not.toBe("flight");
    expect(possibleModes(CAN, CAN_SZX, distanceKm(CAN, CAN_SZX))).not.toContain("flight");
    const intl = travelOptions(TYO, BJS, []);
    expect(intl.map((o) => o.mode)).toEqual(["flight"]);
    expect(intl[0]!.recommended).toBe(true);
  });

  it("never drives or buses between islands", () => {
    const modes = travelOptions(DPS, LOP, []).map((o) => o.mode);
    expect(modes).not.toContain("car");
    expect(modes).not.toContain("bus");
  });

  it("splits a rental car across the group", () => {
    const solo = travelOptions(CNX, CEI, [], { travellers: 1 }).find((o) => o.mode === "car")!;
    const six = travelOptions(CNX, CEI, [], { travellers: 6 }).find((o) => o.mode === "car")!;
    expect(six.note).toContain("2 cars for 6");
    expect(six.costPerPersonCad).toBeLessThan(solo.costPerPersonCad);
  });

  it("changes the recommendation with the priority", () => {
    const fastest = travelOptions(CKG, CAN, [], { priority: "fastest" })[0]!;
    const cheapest = travelOptions(CKG, CAN, [], { priority: "cheapest" })[0]!;
    expect(fastest.mode).toBe("flight");
    expect(["bus", "train"]).toContain(cheapest.mode);
    expect(cheapest.costPerPersonCad).toBeLessThan(fastest.costPerPersonCad);
    expect([fastest, cheapest].every((o) => o.recommended)).toBe(true);
  });

  it("marks exactly one option as recommended", () => {
    const opts = travelOptions(CKG, CAN, [], { travellers: 6 });
    expect(opts.filter((o) => o.recommended)).toHaveLength(1);
    expect(opts[0]!.recommended).toBe(true);
  });
});
