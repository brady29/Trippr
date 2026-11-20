import { describe, expect, it } from "vitest";
import { isGoogleMapsLink, isShortMapsLink, judgeDistance, parseMapLink, placeLinks } from "../src/places";

const TOKYO = { lat: 35.68, lon: 139.69 };

describe("map links", () => {
  it("prefers the place in a Google Maps link over the camera", () => {
    expect(
      parseMapLink("https://www.google.com/maps/place/Shibuya+Sky/@35.6585,139.6990,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d35.65848!4d139.70224"),
    ).toEqual({ lat: 35.65848, lon: 139.70224 });
    expect(parseMapLink("https://www.google.com/maps/@35.6585,139.699,15z")).toEqual({ lat: 35.6585, lon: 139.699 });
  });

  it("reads coordinates from query links, Apple Maps and plain text", () => {
    expect(parseMapLink("https://www.google.com/maps/search/?api=1&query=29.5630,106.5516")).toEqual({ lat: 29.563, lon: 106.5516 });
    expect(parseMapLink("https://maps.apple.com/?ll=22.2793,114.1628&q=Pin")).toEqual({ lat: 22.2793, lon: 114.1628 });
    expect(parseMapLink(" 35.6595, 139.7004 ")).toEqual({ lat: 35.6595, lon: 139.7004 });
  });

  it("rejects text that isn't a point", () => {
    expect(parseMapLink("https://www.google.com/maps/search/?api=1&query=Shibuya+Sky")).toBeNull();
    expect(parseMapLink("not a link")).toBeNull();
    expect(parseMapLink("95, 200")).toBeNull();
  });

  it("knows short share links from full ones", () => {
    expect(isShortMapsLink("https://maps.app.goo.gl/abc123")).toBe(true);
    expect(isShortMapsLink("https://evil.example/maps.app.goo.gl")).toBe(false);
    expect(isGoogleMapsLink("https://www.google.com/maps/place/x")).toBe(true);
    expect(isGoogleMapsLink("https://maps.google.co.jp/?q=1,2")).toBe(true);
    expect(isGoogleMapsLink("https://www.google.com/search?q=maps")).toBe(false);
  });
});

describe("distance check", () => {
  it("trusts points near the city, flags day trips and rejects far ones", () => {
    expect(judgeDistance({ lat: 35.66, lon: 139.7 }, TOKYO)).toBe("placed");
    expect(judgeDistance({ lat: 35.36, lon: 138.73 }, TOKYO)).toBe("check"); // Mount Fuji, about 95 km
    expect(judgeDistance({ lat: 34.69, lon: 135.5 }, TOKYO)).toBe("too_far"); // Osaka
  });
});

describe("place links", () => {
  it("orders website, tickets, maps and source, without repeats", () => {
    const links = placeLinks({
      title: "Shibuya Sky",
      cityName: "Tokyo",
      countryIso: "JP",
      website: "https://www.shibuya-scramble-square.com/sky/",
      ticketUrl: "https://www.klook.com/activity/1/",
      url: "https://www.tiktok.com/@a/video/1",
    });
    expect(links.map((l) => l.kind)).toEqual(["website", "tickets", "google-maps", "source"]);
    expect(links[2]!.url).toBe("https://www.google.com/maps/search/?api=1&query=Shibuya%20Sky%2C%20Tokyo");
    expect(links[3]!.label).toBe("Source · tiktok.com");
  });

  it("uses a shared Google Maps link as is", () => {
    const links = placeLinks({ title: "Ramen", cityName: "Tokyo", mapsUrl: "https://maps.app.goo.gl/abc" });
    expect(links.find((l) => l.kind === "google-maps")!.url).toBe("https://maps.app.goo.gl/abc");
  });

  it("adds Apple Maps and Amap for pinned places in China", () => {
    const links = placeLinks({ title: "Liziba station", cityName: "Chongqing", countryIso: "CN", lat: 29.5536, lon: 106.5418 });
    expect(links.map((l) => l.kind)).toEqual(["google-maps", "apple-maps", "amap"]);
    expect(links[1]!.url).toBe("https://maps.apple.com/?q=Liziba+station&ll=29.5536%2C106.5418");
    expect(links[2]!.url).toBe(
      "https://uri.amap.com/marker?position=106.5418%2C29.5536&name=Liziba+station&src=trippr&coordinate=wgs84&callnative=1",
    );
    const unpinned = placeLinks({ title: "Hotpot", cityName: "Chongqing", countryIso: "CN" });
    expect(unpinned.map((l) => l.kind)).toEqual(["google-maps", "apple-maps"]);
  });
});
