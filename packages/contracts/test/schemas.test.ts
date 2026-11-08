import { describe, expect, it } from "vitest";
import { addStopBody, cityCode, createActivityBody, hasRole, patchRouteBody, whenSchema } from "../src";

describe("contracts", () => {
  it("accepts the three shapes of `when` and rejects others", () => {
    expect(whenSchema.safeParse({ on: "2027-05-13" }).success).toBe(true);
    expect(whenSchema.safeParse({ from: "2027-05-09", to: "2027-05-23" }).success).toBe(true);
    expect(whenSchema.safeParse({ weekdays: [3] }).success).toBe(true);
    expect(whenSchema.safeParse({ from: "2027-05-23", to: "2027-05-09" }).success).toBe(false);
    expect(whenSchema.safeParse({ on: "2027-02-30" }).success).toBe(false);
    expect(whenSchema.safeParse({ weekdays: [7] }).success).toBe(false);
  });

  it("normalises city codes", () => {
    expect(cityCode.parse(" ckg ")).toBe("CKG");
    expect(cityCode.safeParse("CK").success).toBe(false);
  });

  it("defaults new stops to two nights by flight", () => {
    expect(addStopBody.parse({ cityCode: "CKG", version: 3 })).toMatchObject({ nights: 2, arriveMode: "flight" });
  });

  it("requires a version on route writes", () => {
    expect(patchRouteBody.safeParse({ name: "Budget" }).success).toBe(false);
  });

  it("lower-cases tags on activities", () => {
    const parsed = createActivityBody.parse({ tripId: "t", cityCode: "CKG", title: "Liziba", tags: ["Tech"] });
    expect(parsed.tags).toEqual(["tech"]);
  });

  it("ranks roles", () => {
    expect(hasRole("owner", "editor")).toBe(true);
    expect(hasRole("viewer", "editor")).toBe(false);
    expect(hasRole(null, "viewer")).toBe(false);
  });
});
