import { describe, expect, it } from "vitest";
import { classifyLink, isPrivateHost, namesMatch, safeWebUrl, urlBackedBy, urlsIn } from "../src/links";

describe("classifyLink", () => {
  it.each([
    ["https://www.tiktok.com/@someone/video/7312345678901234567", "social"],
    ["https://vm.tiktok.com/ZMabc123/", "social"],
    ["https://www.instagram.com/reel/C1abcDEF/", "social"],
    ["https://www.youtube.com/shorts/abcDEF12345", "social"],
    ["https://youtu.be/abcDEF12345", "social"],
    ["https://m.youtube.com/watch?v=abcDEF12345", "social"],
    ["https://www.xiaohongshu.com/explore/65a1b2c3d4", "social"],
    ["http://xhslink.com/a/AbCdEf", "social"],
    ["https://v.douyin.com/iAbCdEf/", "social"],
    ["https://www.facebook.com/watch/?v=123", "social"],
    ["https://fb.watch/abc123/", "social"],
  ])("social: %s", (url, kind) => expect(classifyLink(url)).toBe(kind));

  it.each([
    ["https://maps.app.goo.gl/AbCdEf123", "google-maps"],
    ["https://goo.gl/maps/AbCdEf", "google-maps"],
    ["https://www.google.com/maps/place/Shibuya+Sky/@35.65,139.70,17z", "google-maps"],
    ["https://maps.google.com/?q=35.6,139.7", "google-maps"],
    ["https://www.google.co.jp/maps/place/Fushimi+Inari", "google-maps"],
  ])("google maps: %s", (url, kind) => expect(classifyLink(url)).toBe(kind));

  it.each([
    ["https://www.klook.com/en-CA/activity/1234-teamlab-planets-tokyo/", "ticket"],
    ["https://www.kkday.com/en/product/12345", "ticket"],
    ["https://www.getyourguide.com/tokyo-l193/sumo-t12345/", "ticket"],
    ["https://www.trip.com/things-to-do/detail/12345/", "ticket"],
    ["https://us.trip.com/travel-guide/attraction/tokyo/tokyo-skytree-12345/", "ticket"],
  ])("tickets and tours: %s", (url, kind) => expect(classifyLink(url)).toBe(kind));

  it.each([
    ["https://tabelog.com/en/tokyo/A1301/A130101/13001234/", "restaurant"],
    ["https://www.opentable.com/r/some-place-toronto", "restaurant"],
    ["https://www.dianping.com/shop/H1abcdEF", "restaurant"],
    ["https://app.catchtable.co.kr/ct/shop/abc", "restaurant"],
    ["https://www.tablecheck.com/en/shops/sushi-place/reserve", "restaurant"],
  ])("restaurant booking: %s", (url, kind) => expect(classifyLink(url)).toBe(kind));

  it.each([
    ["https://www.booking.com/hotel/jp/some-hotel.html", "hotel"],
    ["https://www.agoda.com/some-hotel/hotel/tokyo-jp.html", "hotel"],
    ["https://www.trip.com/hotels/tokyo-hotel-detail-12345/", "hotel"],
    ["https://www.airbnb.ca/rooms/123456", "hotel"],
  ])("hotels: %s", (url, kind) => expect(classifyLink(url)).toBe(kind));

  it.each([
    ["https://www.aircanada.com/ca/en/aco/home/app.html", "transport"],
    ["https://www.trip.com/trains/china/", "transport"],
    ["https://kyfw.12306.cn/otn/", "transport"],
    ["https://www.google.com/travel/flights?q=yyz-hnd", "transport"],
  ])("transport: %s", (url, kind) => expect(classifyLink(url)).toBe(kind));

  it("falls back to article for other pages and unknown for everything else", () => {
    expect(classifyLink("https://www.timeout.com/tokyo/restaurants/best-ramen-in-tokyo")).toBe("article");
    expect(classifyLink("https://www.teamlab.art/e/planets/")).toBe("article");
    expect(classifyLink("https://www.trip.com/blog/tokyo")).toBe("article");
    expect(classifyLink("mailto:someone@example.com")).toBe("unknown");
    expect(classifyLink("not a link")).toBe("unknown");
    expect(classifyLink("javascript:alert(1)")).toBe("unknown");
  });
});

describe("safeWebUrl", () => {
  it("keeps public https links", () => {
    expect(safeWebUrl(" https://www.teamlab.art/e/planets/ ")).toBe("https://www.teamlab.art/e/planets/");
    expect(safeWebUrl("https://www.klook.com/activity/1/?ref=abc")).toBe("https://www.klook.com/activity/1/?ref=abc");
  });

  it("refuses other schemes, private hosts, credentials, odd ports and long links", () => {
    expect(safeWebUrl("http://www.teamlab.art/")).toBeNull();
    expect(safeWebUrl("javascript:alert(1)")).toBeNull();
    expect(safeWebUrl("data:text/html,hi")).toBeNull();
    expect(safeWebUrl("https://127.0.0.1/admin")).toBeNull();
    expect(safeWebUrl("https://10.0.0.5/")).toBeNull();
    expect(safeWebUrl("https://[::1]/")).toBeNull();
    expect(safeWebUrl("https://localhost:8080/")).toBeNull();
    expect(safeWebUrl("https://api.localhost/")).toBeNull();
    expect(safeWebUrl("https://intranet/")).toBeNull();
    expect(safeWebUrl("https://user:pass@example.com/")).toBeNull();
    expect(safeWebUrl("https://example.com:8443/")).toBeNull();
    expect(safeWebUrl(`https://example.com/${"a".repeat(600)}`)).toBeNull();
    expect(safeWebUrl("https://exa mple.com/")).toBeNull();
    expect(safeWebUrl(null)).toBeNull();
    expect(safeWebUrl("")).toBeNull();
  });

  it("knows private hosts", () => {
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("printer.local")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
  });
});

describe("urlBackedBy", () => {
  const seen = ["https://www.teamlab.art/e/planets/", "https://www.klook.com/en-CA/activity/1234-teamlab/?utm=x", "https://example.org/a/b/c"];

  it("accepts the same page, ignoring www, query, fragment and a trailing slash", () => {
    expect(urlBackedBy("https://teamlab.art/e/planets", seen)).toBe(true);
    expect(urlBackedBy("https://www.klook.com/en-CA/activity/1234-teamlab/#top", seen)).toBe(true);
  });

  it("accepts a parent page of one it saw, such as the home page", () => {
    expect(urlBackedBy("https://www.teamlab.art/", seen)).toBe(true);
    expect(urlBackedBy("https://example.org/a", seen)).toBe(true);
  });

  it("refuses pages it never saw", () => {
    expect(urlBackedBy("https://www.teamlab.art/e/borderless/", seen)).toBe(false);
    expect(urlBackedBy("https://teamlab-tickets.example.com/", seen)).toBe(false);
    expect(urlBackedBy("https://example.org/a/bc", seen)).toBe(false);
    expect(urlBackedBy("not a url", seen)).toBe(false);
    expect(urlBackedBy("https://www.teamlab.art/", [])).toBe(false);
  });

  it("finds urls in text", () => {
    expect(urlsIn("See https://a.example.com/x. And (https://b.example.com/y) too")).toEqual(["https://a.example.com/x", "https://b.example.com/y"]);
    expect(urlsIn(null)).toEqual([]);
  });
});

describe("namesMatch", () => {
  it("matches names that share a real word, ignoring the city", () => {
    expect(namesMatch("Shibuya Sky", "Shibuya Scramble Square, Shibuya, Tokyo, Japan")).toBe(true);
    expect(namesMatch("Tokyo Tower", "Some Ramen Shop, Minato, Tokyo, Japan", ["Tokyo", "Japan"])).toBe(false);
    expect(namesMatch("Tokyo Tower", "Tokyo Tower, Shibakoen, Minato, Tokyo, Japan", ["Tokyo", "Japan"])).toBe(true);
    expect(namesMatch("洪崖洞", "洪崖洞, 渝中区, 重庆市")).toBe(true);
    expect(namesMatch("Hongyadong", "Chaotianmen Square, Chongqing")).toBe(false);
    expect(namesMatch(null, "x")).toBe(false);
  });
});
