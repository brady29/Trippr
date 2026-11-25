import { suggestionsQuery } from "@trippr/contracts";
import { describe, expect, it } from "vitest";
import type { CityActivity } from "../src/repositories/recommend";
import {
  TUNING,
  buildSignals,
  buildTaste,
  categoryRanks,
  dot,
  likedTags,
  scoreByTaste,
  scoreCold,
  selectMmr,
  suggestForCity,
  unit,
  type Candidate,
  type Scored,
} from "../src/services/recommend/core";
import { closenessWord, explain, rankPhrase, whatTheGroupDid } from "../src/services/recommend/explain";
import { noticeFor } from "../src/services/recommend/service";

// No database in this file: the scoring, diversification and explanations are pure functions.

const row = (id: string, over: Partial<CityActivity> = {}): CityActivity => ({
  id,
  title: id,
  catalogue: true,
  listed: true,
  category: "museum",
  rank: 10,
  score: 3,
  bestTime: null,
  indoor: null,
  votes: [],
  planCount: 0,
  commentCount: 0,
  tags: ["culture"],
  ...over,
});
const up = (...users: string[]) => users.map((userId) => ({ userId, value: 1 }));
const down = (...users: string[]) => users.map((userId) => ({ userId, value: -1 }));

/** Directions in a 4-dimensional space: [temples, food, parks, nightlife]. */
const V = {
  temple: unit([1, 0, 0, 0]),
  templeish: unit([0.9, 0.1, 0, 0]),
  templeToo: unit([0.95, 0, 0.1, 0]),
  ramen: unit([0, 1, 0, 0]),
  ramenish: unit([0.1, 0.95, 0, 0]),
  park: unit([0, 0, 1, 0]),
  bar: unit([0, 0, 0, 1]),
};
const vectors = (map: Record<string, Float32Array>) => (id: string) => map[id] ?? null;

describe("signals", () => {
  it("one member voting on everything does not outweigh three members voting on a little", () => {
    const rows = [
      row("a", { votes: up("big", "x") }),
      row("b", { votes: up("big", "y") }),
      row("c", { votes: up("big", "z") }),
      row("d", { votes: up("big") }),
    ];
    const byId = Object.fromEntries(buildSignals(rows, () => null).map((s) => [s.id, s]));
    // "big" voted on four places (share 1/2), the others on one (share 1).
    expect(byId.a!.weight).toBeCloseTo(0.5 + 1, 6);
    expect(byId.d!.weight).toBeCloseTo(0.5, 6);
    expect(byId.a!.voters).toBe(2);
  });

  it("counts a plan, adds a little for comments only on a place that is not voted down, and drops places with no net signal", () => {
    const rows = [
      row("planned", { planCount: 1 }),
      row("talked", { commentCount: 5, votes: up("u") }),
      row("hated", { commentCount: 3, votes: down("u") }),
      row("quiet"),
      row("even", { votes: [...up("u"), ...down("v")] }),
    ];
    const byId = Object.fromEntries(buildSignals(rows, () => null).map((s) => [s.id, s]));
    expect(byId.planned!.weight).toBe(TUNING.planWeight);
    expect(byId.planned!.planned).toBe(true);
    // The user voted on 3 places (share 1/sqrt 3): talked = share + 2 capped comments.
    const share = 1 / Math.sqrt(3);
    expect(byId.talked!.weight).toBeCloseTo(share + TUNING.commentCap * TUNING.commentWeight, 6);
    expect(byId.hated!.weight).toBeCloseTo(-share, 6); // comments on a disliked place are not read as liking it
    expect(byId.quiet).toBeUndefined();
    expect(byId.even).toBeDefined(); // the two voters have different shares, so the votes do not cancel exactly
  });

  it("a place the group planned and one member voted down is still net liked", () => {
    const [s] = buildSignals([row("x", { planCount: 1, votes: down("u") })], () => null);
    expect(s!.weight).toBeGreaterThan(0);
  });
});

describe("taste", () => {
  it("is the weighted average of the liked places, pushed away from the disliked ones", () => {
    const rows = [row("t", { votes: up("u") }), row("r", { votes: down("u") })];
    const signals = buildSignals(rows, vectors({ t: V.temple, r: V.ramen }));
    const taste = buildTaste(signals)!;
    expect(dot(taste.vector, V.temple)).toBeGreaterThan(0.85);
    expect(dot(taste.vector, V.ramen)).toBeLessThan(0);
    const plain = buildTaste(buildSignals([rows[0]!], vectors({ t: V.temple })))!;
    expect(dot(plain.vector, V.ramen)).toBeCloseTo(0, 6);
  });

  it("is null when no liked place has a vector", () => {
    expect(buildTaste(buildSignals([row("t", { votes: up("u") })], () => null))).toBeNull();
    expect(buildTaste(buildSignals([row("r", { votes: down("u") })], vectors({ r: V.ramen })))).toBeNull();
  });

  it("falls back to the plain average when liked and disliked cancel out", () => {
    const rows = [row("a", { votes: up("u") }), row("b", { votes: down("v") })];
    const taste = buildTaste(buildSignals(rows, vectors({ a: V.temple, b: V.temple })), { ...TUNING, dislikeLambda: 1 });
    expect(taste?.vector.some((x) => x !== 0)).toBe(true);
  });
});

describe("scoring", () => {
  const taste = () => buildTaste(buildSignals([row("liked", { votes: up("u", "v") })], vectors({ liked: V.temple })))!;
  const cand = (id: string, vector: Float32Array | null, over: Partial<CityActivity> = {}): Candidate => ({ row: row(id, over), vector, categoryRank: null });

  it("ranks the places near what was liked above the far ones, and names the nearest liked place", () => {
    const t = taste();
    const near = scoreByTaste(cand("near", V.templeish), t)!;
    const far = scoreByTaste(cand("far", V.ramen), t)!;
    expect(near.relevance).toBeGreaterThan(far.relevance);
    expect(near.anchor?.id).toBe("liked");
    expect(near.anchorSim).toBeGreaterThan(0.9);
  });

  it("leaves out a place that is a near-copy of one the group voted down, and a place without a vector", () => {
    const rows = [row("liked", { votes: up("u") }), row("hated", { votes: down("u", "v") })];
    const t = buildTaste(buildSignals(rows, vectors({ liked: V.temple, hated: V.ramen })))!;
    expect(scoreByTaste(cand("copy", V.ramenish), t)).toBeNull();
    expect(scoreByTaste(cand("novec", null), t)).toBeNull();
    expect(scoreByTaste(cand("fine", V.park), t)).not.toBeNull();
  });

  it("the city's rank only breaks near ties", () => {
    const t = taste();
    const first = scoreByTaste(cand("a", V.templeish, { rank: 1 }), t)!;
    const last = scoreByTaste(cand("b", V.templeish, { rank: 200 }), t)!;
    expect(first.relevance - last.relevance).toBeGreaterThan(0);
    expect(first.relevance - last.relevance).toBeLessThan(TUNING.priorWeight);
  });

  it("cold start leans toward liked tags but still respects the city's ranking", () => {
    const tags = [{ tag: "food", weight: 4 }, { tag: "culture", weight: 1 }];
    const best = scoreCold(cand("rank1", null, { rank: 1, tags: ["nature"] }), tags);
    const food = scoreCold(cand("food20", null, { rank: 20, tags: ["food"] }), tags);
    const plain = scoreCold(cand("plain20", null, { rank: 20, tags: ["nature"] }), tags);
    expect(food.relevance).toBeGreaterThan(plain.relevance);
    expect(food.tag).toBe("food");
    expect(best.tag).toBeNull();
    expect(best.relevance).toBeGreaterThan(food.relevance); // rank 1 still beats a tag match twenty places down
    expect(scoreCold(cand("none", null, { rank: 1 }), []).relevance).toBe(1);
  });
});

describe("maximal marginal relevance", () => {
  const pick = (id: string, relevance: number, vector: Float32Array | null, category: string | null = "museum"): Scored => ({
    candidate: { row: row(id, { category }), vector, categoryRank: null },
    relevance,
    anchor: null,
    anchorSim: null,
    tag: null,
  });

  it("does not take two near-duplicates when a different place is nearly as relevant", () => {
    const chosen = selectMmr([pick("a", 0.9, V.temple), pick("b", 0.89, V.templeish), pick("c", 0.8, V.ramen)], 2);
    expect(chosen.map((s) => s.candidate.row.id)).toEqual(["a", "c"]);
  });

  it("with lambda 1 it is plain relevance order", () => {
    const chosen = selectMmr([pick("a", 0.9, V.temple), pick("b", 0.89, V.templeish), pick("c", 0.8, V.ramen)], 3, { ...TUNING, mmrLambda: 1, categoryPenalty: 0 });
    expect(chosen.map((s) => s.candidate.row.id)).toEqual(["a", "b", "c"]);
  });

  it("charges for a crowded category even when the vectors say nothing", () => {
    const chosen = selectMmr([pick("m1", 0.5, null, "museum"), pick("m2", 0.49, null, "museum"), pick("p1", 0.47, null, "park")], 2);
    expect(chosen.map((s) => s.candidate.row.id)).toEqual(["m1", "p1"]);
  });

  it("returns fewer when there are fewer, and is deterministic on ties", () => {
    expect(selectMmr([pick("b", 0.5, null), pick("a", 0.5, null)], 5).map((s) => s.candidate.row.id)).toEqual(["a", "b"]);
    expect(selectMmr([], 3)).toEqual([]);
  });
});

describe("tags and category ranks", () => {
  it("counts this city's liked places in full and the other cities' tags by their share, and ignores dislikes", () => {
    const signals = buildSignals([row("a", { votes: up("u"), tags: ["culture"] }), row("b", { votes: down("u"), tags: ["food"] })], () => null);
    const tags = likedTags(signals, [{ tag: "food", weight: 6 }, { tag: "nature", weight: 1 }, { tag: "sport", weight: -3 }]);
    expect(tags.map((t) => t.tag)).toEqual(["food", "culture", "nature"]);
    expect(tags[0]!.weight).toBeCloseTo(3 * 1, 6); // 6 x 0.5
  });

  it("ranks each place inside its own category by the catalogue rank", () => {
    const ranks = categoryRanks([
      row("m3", { rank: 30 }),
      row("m1", { rank: 3 }),
      row("p1", { rank: 5, category: "park" }),
      row("own", { catalogue: false, rank: 1 }),
      row("gone", { listed: false, rank: 2 }),
    ]);
    expect(ranks.get("m1")).toBe(1);
    expect(ranks.get("m3")).toBe(2);
    expect(ranks.get("p1")).toBe(1);
    expect(ranks.has("own")).toBe(false);
    expect(ranks.has("gone")).toBe(false);
  });
});

describe("the reason", () => {
  const anchor = (over: Partial<Parameters<typeof whatTheGroupDid>[0]> = {}) => ({
    id: "fushimi", title: "Fushimi Inari", category: "temple_shrine", tags: ["culture"], weight: 3, voters: 3, downVoters: 0, votedBy: ["a", "b", "c"], planned: false, comments: 0, vector: V.temple, ...over,
  });
  const input = (over: Partial<Parameters<typeof explain>[0]> = {}): Parameters<typeof explain>[0] => ({
    basis: "group_taste", row: row("x", { category: "museum", rank: 14, tags: ["culture"] }), cityName: "Osaka", categoryRank: 4, anchor: anchor(), anchorSim: 0.7, likedTags: ["culture"], userId: "me", tuning: TUNING, ...over,
  });

  it("names the liked place and who voted for it", () => {
    const r = explain(input());
    expect(r.text).toBe("Similar to Fushimi Inari, which 3 of you voted for");
    expect(r.because).toBe("similar");
    expect(r.closeness).toBe("very close");
    expect(explain(input({ anchorSim: 0.5 })).closeness).toBe("close");
  });

  it("says it in the first person when the member asking is the only voter, and mentions plans", () => {
    expect(whatTheGroupDid(anchor({ voters: 1, votedBy: ["me"] }), "me")).toBe("you voted for");
    expect(whatTheGroupDid(anchor({ voters: 1, votedBy: ["other"] }), "me")).toBe("one of you voted for");
    expect(whatTheGroupDid(anchor({ voters: 2, votedBy: ["a", "b"], planned: true }), "me")).toBe("2 of you voted for and planned");
    expect(whatTheGroupDid(anchor({ voters: 0, votedBy: [], planned: true }), "me")).toBe("your group planned");
    expect(whatTheGroupDid(anchor({ voters: 0, votedBy: [], planned: false, comments: 2 }), "me")).toBe("your group commented on");
  });

  it("does not name a liked place that is only loosely related; it falls back to a fact about the place and a tag the group likes", () => {
    const r = explain(input({ anchorSim: 0.3 }));
    expect(r.because).toBe("tag");
    expect(r.text).toBe("Ranked #14 in Osaka; your group likes culture");
    expect(r.anchor).toBeNull();
    expect(r.closeness).toBeNull();
  });

  it("states rank facts the way the data gives them", () => {
    expect(rankPhrase({ rank: 3, category: "museum" }, "Osaka", 1)).toBe("Top-ranked museum in Osaka");
    expect(rankPhrase({ rank: 9, category: "temple_shrine" }, "Osaka", 2)).toBe("#2 temple shrine in Osaka");
    expect(rankPhrase({ rank: 9, category: "museum" }, "Osaka", 7)).toBe("Ranked #9 in Osaka");
    expect(rankPhrase({ rank: null, category: "park" }, "Osaka", null)).toBe("Park in Osaka");
    expect(rankPhrase({ rank: null, category: null }, "Osaka", null)).toBe("In the Osaka catalogue");
    expect(explain(input({ anchor: null, anchorSim: null, likedTags: [], categoryRank: 1 })).text).toBe("Top-ranked museum in Osaka");
  });

  it("never shows a similarity number or claims a model wrote it", () => {
    const texts = [explain(input()), explain(input({ anchorSim: 0.2 })), explain(input({ anchor: null, likedTags: [] }))].map((r) => r.text);
    for (const t of texts) {
      expect(t).not.toMatch(/%|0\.\d|similarity|score|\bAI\b|language model|LLM|generated/i);
    }
    expect(closenessWord(0.61, TUNING)).toBe("very close");
    expect(closenessWord(0.46, TUNING)).toBe("close");
    expect(closenessWord(0.1, TUNING)).toBe("loosely related");
  });
});

describe("suggestForCity", () => {
  const base = {
    cityName: "Osaka",
    otherTags: [],
    userId: "me",
    limit: 5,
  };

  it("suggests places like the ones the group liked, never ones already planned, voted, commented on, unlisted or its own", () => {
    const rows = [
      row("liked-temple", { votes: up("me", "you"), catalogue: false, tags: ["culture"], category: "temple_shrine" }),
      row("temple-2", { category: "temple_shrine", rank: 3 }),
      row("temple-planned", { category: "temple_shrine", planCount: 1 }),
      row("temple-voted", { category: "temple_shrine", votes: down("you") }),
      row("temple-commented", { category: "temple_shrine", commentCount: 1 }),
      row("temple-gone", { category: "temple_shrine", listed: false }),
      row("temple-own", { category: "temple_shrine", catalogue: false }),
      row("ramen-1", { category: "restaurant", tags: ["food"], rank: 1 }),
      row("park-1", { category: "park", tags: ["nature"], rank: 2 }),
    ];
    const out = suggestForCity({
      ...base,
      rows,
      vectorOf: vectors({ "liked-temple": V.temple, "temple-2": V.templeish, "temple-planned": V.templeToo, "temple-voted": V.bar, "temple-commented": V.templeish, "temple-gone": V.templeish, "temple-own": V.templeish, "ramen-1": V.ramen, "park-1": V.park }),
    });
    expect(out.basis).toBe("group_taste");
    const ids = out.picks.map((p) => p.row.id);
    expect(ids[0]).toBe("temple-2");
    expect(ids).toEqual(expect.arrayContaining(["ramen-1", "park-1"]));
    for (const banned of ["temple-planned", "temple-voted", "temple-commented", "temple-gone", "temple-own", "liked-temple"]) expect(ids).not.toContain(banned);
    expect(out.picks[0]!.reason.text).toBe("Similar to liked-temple, which 2 of you voted for");
    expect(out).toMatchObject({ liked: 3, disliked: 1, members: 2, candidates: 3 }); // liked: the voted, the planned and the commented-on place
    // The far places are explained by facts, not by a liked place.
    expect(out.picks.find((p) => p.row.id === "park-1")!.because).not.toBe("similar");
  });

  it("every pick has a reason", () => {
    const rows = [row("l", { votes: up("me") }), ...Array.from({ length: 12 }, (_, i) => row(`c${i}`, { rank: i + 1, category: i % 2 ? "park" : "museum" }))];
    for (const withVectors of [true, false]) {
      const out = suggestForCity({ ...base, limit: 10, rows, vectorOf: withVectors ? (id) => (id === "l" ? V.temple : [V.templeish, V.park, V.ramen, V.bar][id.length % 4]!) : () => null });
      expect(out.picks).toHaveLength(10);
      for (const p of out.picks) expect(p.reason.text.length).toBeGreaterThan(5);
    }
  });

  it("diversifies: when the group likes two kinds of place, two copies of the same temple do not both make a short list", () => {
    const rows = [
      row("likes-temple", { votes: up("me") }),
      row("likes-ramen", { votes: up("you"), category: "restaurant" }),
      row("twin-a", { rank: 1 }),
      row("twin-b", { rank: 2 }),
      row("noodles", { rank: 30, category: "restaurant" }),
    ];
    const vectorOf = vectors({ "likes-temple": V.temple, "likes-ramen": V.ramen, "twin-a": V.templeish, "twin-b": V.templeish, noodles: V.ramenish });
    expect(suggestForCity({ ...base, limit: 2, rows, vectorOf }).picks.map((p) => p.row.id)).toEqual(["twin-a", "noodles"]);
    // With diversity turned off the second copy takes the second place.
    const plain = suggestForCity({ ...base, limit: 2, rows, vectorOf }, { ...TUNING, mmrLambda: 1, categoryPenalty: 0 });
    expect(plain.picks.map((p) => p.row.id)).toEqual(["twin-a", "twin-b"]);
  });

  it("cold start: the city's ranking, leaning toward tags liked in other cities, and says why", () => {
    const rows = [row("a", { rank: 1, tags: ["nature"], category: "park" }), row("b", { rank: 8, tags: ["food"], category: "restaurant" }), row("c", { rank: 2, tags: ["nature"], category: "park" })];
    const out = suggestForCity({ ...base, rows, otherTags: [{ tag: "food", weight: 5 }], vectorOf: () => null });
    expect(out.basis).toBe("tag_preferences");
    expect(out.likedTags).toEqual(["food"]);
    expect(out.picks.map((p) => p.row.id)).toEqual(["a", "b", "c"].sort((x, y) => out.picks.findIndex((p) => p.row.id === x) - out.picks.findIndex((p) => p.row.id === y)));
    expect(out.picks.find((p) => p.row.id === "b")!.reason.text).toBe("Top-ranked restaurant in Osaka; your group likes food");
    expect(out.picks.find((p) => p.row.id === "a")!.reason.text).toBe("Top-ranked park in Osaka");
    expect(noticeFor(out, { cityName: "Osaka", vectors: true })).toMatchObject({ code: "cold_start" });
    expect(noticeFor(out, { cityName: "Osaka", vectors: true })!.message).toContain("food");
  });

  it("with no signals anywhere it is the city's rank order", () => {
    const rows = [row("z", { rank: 9 }), row("a", { rank: 1 }), row("m", { rank: 4 })];
    const out = suggestForCity({ ...base, rows, vectorOf: () => null, limit: 3 });
    expect(out.basis).toBe("catalogue_rank");
    expect(out.likedTags).toEqual([]);
    expect(out.picks.map((p) => p.row.id)).toEqual(["a", "m", "z"]);
  });

  it("liked places without vectors count for tags but similarity is not claimed", () => {
    const rows = [row("l", { votes: up("me"), catalogue: false, tags: ["food"] }), row("c", { rank: 5, tags: ["food"] })];
    const out = suggestForCity({ ...base, rows, vectorOf: vectors({ c: V.ramen }) });
    expect(out.basis).toBe("tag_preferences");
    expect(out.picks[0]!.because).toBe("tag");
    expect(noticeFor(out, { cityName: "Osaka", vectors: true })).toMatchObject({ code: "no_taste" });
    expect(noticeFor(out, { cityName: "Osaka", vectors: false })).toMatchObject({ code: "no_vectors" });
  });

  it("filters on the enrichment fields, leaving out places the enrichment could not tell", () => {
    const rows = [
      row("evening", { bestTime: "evening", indoor: false }),
      row("any", { bestTime: "any", indoor: true }),
      row("unknown"),
      row("morning-in", { bestTime: "morning", indoor: true }),
    ];
    const ids = (o: object) => suggestForCity({ ...base, rows, vectorOf: () => null, ...o }).picks.map((p) => p.row.id).sort();
    expect(ids({ bestTime: "evening" })).toEqual(["any", "evening"]);
    expect(ids({ indoor: true })).toEqual(["any", "morning-in"]);
    expect(ids({ indoor: false })).toEqual(["evening"]);
  });

  it("says when nothing is left", () => {
    const out = suggestForCity({ ...base, rows: [row("only", { planCount: 1 })], vectorOf: () => null });
    expect(out.picks).toEqual([]);
    expect(noticeFor(out, { cityName: "Osaka", vectors: true })).toMatchObject({ code: "none_left" });
  });

  it("is repeatable", () => {
    const rows = [row("l", { votes: up("me") }), ...Array.from({ length: 9 }, (_, i) => row(`c${i}`, { rank: i + 1 }))];
    const vectorOf = (id: string) => (id === "l" ? V.temple : unit([1, i2(id), 0, 0]));
    const a = suggestForCity({ ...base, rows, vectorOf });
    const b = suggestForCity({ ...base, rows: [...rows].reverse(), vectorOf });
    expect(b.picks.map((p) => p.row.id)).toEqual(a.picks.map((p) => p.row.id));
  });
});

const i2 = (id: string) => Number(id.replace(/\D/g, "")) / 10;

describe("the request", () => {
  it("defaults to a handful and bounds the limit", () => {
    expect(suggestionsQuery.parse({}).limit).toBe(6);
    expect(suggestionsQuery.parse({ limit: "12", bestTime: "evening", indoor: "false" })).toMatchObject({ limit: 12, bestTime: "evening", indoor: false });
    expect(suggestionsQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(suggestionsQuery.safeParse({ limit: "21" }).success).toBe(false);
    expect(suggestionsQuery.safeParse({ bestTime: "dawn" }).success).toBe(false);
    expect(suggestionsQuery.parse({ bestTime: "", indoor: "" })).toMatchObject({ limit: 6 });
  });
});
