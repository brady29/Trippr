import { describe, expect, it } from "vitest";
import { activityLinks, hotelLinks, travelLinks } from "../src/booking-links";

const YTO = { code: "YTO", name: "Toronto", countryIso: "CA" };
const TYO = { code: "TYO", name: "Tokyo", countryIso: "JP" };
const OSA = { code: "OSA", name: "Osaka", countryIso: "JP" };
const BJS = { code: "BJS", name: "Beijing", countryIso: "CN" };
const SIA = { code: "SIA", name: "Xi'an", countryIso: "CN" };
const HAN = { code: "HAN", name: "Hanoi", countryIso: "VN" };
const SGN = { code: "SGN", name: "Ho Chi Minh City", countryIso: "VN" };

describe("booking links", () => {
  it("fills Trip.com and Google Flights with cities, date and group size", () => {
    const [trip, google] = travelLinks("flight", YTO, TYO, "2027-05-09", 5);
    expect(trip!.url).toBe(
      "https://www.trip.com/flights/showfarefirst?dcity=yto&acity=tyo&ddate=2027-05-09&triptype=ow&class=y&quantity=5&locale=en-US&curr=CAD",
    );
    expect(decodeURIComponent(google!.url)).toContain("Flights from Toronto to Tokyo on 2027-05-09 one way 5 adults");
  });

  it("leaves the date out when there isn't one", () => {
    expect(travelLinks("flight", YTO, TYO, null, 1)[0]!.url).not.toContain("ddate");
  });

  it("sends trains to the right booking site for each country", () => {
    expect(travelLinks("hsr", BJS, SIA, "2027-05-19", 5).map((l) => l.provider)).toEqual(["tripcom-trains", "12go"]);
    expect(travelLinks("hsr", TYO, OSA, "2027-05-12", 5).map((l) => l.provider)).toEqual(["smartex", "12go"]);
    const [twelve] = travelLinks("train", HAN, SGN, "2027-06-05", 5);
    expect(twelve!.url).toBe("https://12go.asia/en/travel/hanoi/ho-chi-minh-city?date=2027-06-05&people=5");
    expect(travelLinks("road", BJS, SIA, null, 2).find((l) => l.provider === "12go")!.url).toContain("/beijing/xian");
    expect(travelLinks("car", HAN, SGN, null, 2)).toEqual([]);
  });

  it("searches hotels for the stop's dates with a room per two people", () => {
    const [booking] = hotelLinks(TYO, "2027-05-10", "2027-05-14", 5);
    expect(booking!.url).toBe(
      "https://www.booking.com/searchresults.html?ss=Tokyo&checkin=2027-05-10&checkout=2027-05-14&group_adults=5&no_rooms=3&selected_currency=CAD",
    );
    expect(hotelLinks(TYO, null, null, 5, 2)[0]!.url).toContain("no_rooms=2");
  });

  it("searches activities by name and city", () => {
    expect(activityLinks(TYO, "Shibuya Sky")[0]!.url).toBe("https://www.klook.com/en-CA/search/result/?query=Shibuya%20Sky%20Tokyo");
  });
});
