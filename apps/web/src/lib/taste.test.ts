import type { LibraryActivity } from "@trippr/contracts";
import { describe, expect, it } from "vitest";
import { consensusHighlights, consensusPoints, tasteProfile } from "./taste";

const idea = (id: string, tags: string[], ups: number, downs: number, myVote: -1 | 0 | 1 = 0) =>
  ({ id, title: id, cityName: "Tokyo", cityCode: "TYO", tags, votes: ups - downs, ups, downs, myVote, plannedIn: [] }) as unknown as LibraryActivity;

describe("consensusPoints", () => {
  it("places loved, hated and split ideas, and leaves out ideas nobody voted on", () => {
    const pts = consensusPoints([idea("loved", ["food"], 4, 0), idea("hated", ["sport"], 0, 3), idea("split", ["culture"], 2, 2), idea("none", [], 0, 0)]);
    const by = Object.fromEntries(pts.map((p) => [p.id, p]));
    expect(Object.keys(by)).toEqual(["loved", "hated", "split"]);
    expect(by.loved).toMatchObject({ liking: 1, agreement: 1, tag: "food" });
    expect(by.hated).toMatchObject({ liking: -1, agreement: 1 });
    expect(by.split).toMatchObject({ liking: 0, agreement: 0 });
  });

  it("picks the ideas everyone loves and the ones that split the group", () => {
    const { loved, split } = consensusHighlights(consensusPoints([idea("a", [], 5, 0), idea("b", [], 3, 3), idea("c", [], 1, 0)]));
    expect(loved.map((p) => p.id)).toEqual(["a", "c"]);
    expect(split.map((p) => p.id)).toEqual(["b"]);
  });
});

describe("tasteProfile", () => {
  it("compares what you say yes to with the group's yes votes", () => {
    const axes = tasteProfile([idea("x", ["food"], 3, 0, 1), idea("y", ["nature"], 1, 0, 1), idea("z", ["food"], 2, 1, 0)]);
    const food = axes.find((a) => a.tag === "food")!;
    expect(food.you).toBe(0.5);
    expect(food.group).toBeCloseTo(5 / 6);
    expect(axes.map((a) => a.tag)).toEqual(["sport", "tech", "nature", "culture", "food"]);
  });
});
