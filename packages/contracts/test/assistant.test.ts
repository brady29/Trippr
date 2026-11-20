import { describe, expect, it } from "vitest";
import { assistantAskBody, assistantFocusIds, emptyRefs, hasRefs } from "../src";

describe("assistant contracts", () => {
  it("trims questions and refuses empty or very long ones", () => {
    expect(assistantAskBody.parse({ message: "  What's still unbooked?  " })).toEqual({ message: "What's still unbooked?" });
    expect(assistantAskBody.safeParse({ message: "   " }).success).toBe(false);
    expect(assistantAskBody.safeParse({ message: "x".repeat(2001) }).success).toBe(false);
    expect(assistantAskBody.safeParse({}).success).toBe(false);
  });

  it("turns references into map node ids", () => {
    const refs = { stopIds: ["s1"], activityIds: ["a1", "a2"], legIds: ["l1"], hotelIds: ["h1"], cityCodes: ["TYO"] };
    expect(assistantFocusIds(refs)).toEqual(["stop:s1", "act:a1", "act:a2", "leg:l1", "hotel:h1", "city:TYO"]);
    expect(hasRefs(refs)).toBe(true);
    expect(hasRefs(emptyRefs())).toBe(false);
    expect(hasRefs(undefined)).toBe(false);
  });
});
