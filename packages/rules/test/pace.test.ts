import { describe, expect, it } from "vitest";
import { bestInsertion, distanceKm, stopPace, suggestedNights } from "../src";

describe("stopPace", () => {
  it("counts half-days: a 14:10 arrival and 3 nights give about 6", () => {
    const pace = stopPace({ nights: 3, arriveAt: "2027-05-15T14:10+09:00", planned: Array.from({ length: 8 }, () => ({})) });
    expect(pace).toMatchObject({ slots: 6, used: 8, level: "over", lateArrival: false });
  });

  it("loses the arrival day to a late landing", () => {
    expect(stopPace({ nights: 2, arriveAt: "2027-05-15T21:40+09:00", planned: [{}] })).toMatchObject({ slots: 3, lateArrival: true, level: "light" });
  });

  it("counts long plans as two half-days and reads an empty stop as empty", () => {
    expect(stopPace({ nights: 2, planned: [{ durationMin: 300 }, { durationMin: 60 }] }).used).toBe(3);
    expect(stopPace({ nights: 4, planned: [] }).level).toBe("empty");
  });

  it("gives a day stop one half-day", () => {
    expect(stopPace({ nights: 0, planned: [{}] })).toMatchObject({ slots: 1, level: "full" });
  });
});

describe("bestInsertion", () => {
  const tokyo = { lat: 35.68, lon: 139.69 };
  const kyoto = { lat: 35.01, lon: 135.77 };
  const osaka = { lat: 34.69, lon: 135.5 };
  const hongKong = { lat: 22.32, lon: 114.17 };
  const nara = { lat: 34.69, lon: 135.8 };

  it("puts Nara between Kyoto and Osaka, not at the end", () => {
    const at = bestInsertion([tokyo, kyoto, osaka, hongKong], nara);
    expect(at.position).toBe(2);
    expect(at.addedKm).toBeLessThan(60);
    expect(at.atEndKm).toBeGreaterThan(2000);
    expect(at.nearest).toMatchObject({ index: 2 });
    expect(suggestedNights(at)).toBe(1);
  });

  it("measures distance on the globe", () => {
    expect(distanceKm(tokyo, osaka)).toBeGreaterThan(390);
    expect(distanceKm(tokyo, osaka)).toBeLessThan(410);
  });

  it("starts an empty route at position 0", () => {
    expect(bestInsertion([], nara)).toMatchObject({ position: 0, nearest: null });
  });
});
