import type { SuggestionBasis } from "@trippr/contracts";
import type { CityActivity, TagWeight } from "../../repositories/recommend";
import { prior } from "../search/ranking";
import { explain, type Reason } from "./explain";

/**
 * "Suggested for this stop", with no database and no network in it: the group's signals become a taste, the city's
 * catalogue places are scored against it and diversified, and each pick gets a reason built from the inputs it used.
 * The service reads the graph and the stored vectors and calls `suggestForCity`; the offline eval calls the same function
 * over a bundle, so what it measures is what the app does.
 */

/** Every number the ranking depends on. They are choices, not fitted values: docs/data-platform.md says how each was checked. */
export const TUNING = {
  /** A planned place counts this much, against 1 for one member's vote: the group committed to it. */
  planWeight: 1.5,
  /** A comment counts this much, at most `commentCap` of them, and only on a place whose votes are not net negative. */
  commentWeight: 0.25,
  commentCap: 2,
  /** How far the disliked places' average pushes the taste away. */
  dislikeLambda: 0.5,
  /** A candidate that close to a place the group voted down is left out. */
  nearDuplicateOfDisliked: 0.85,
  /** Relevance blends the similarity to the group's average taste with the similarity to its nearest liked place. */
  centroidShare: 0.5,
  /** The city's own ranking, as a tie-breaker: 1 / (1 + log2 rank) times this. */
  priorWeight: 0.05,
  /** Maximal marginal relevance: 1 is relevance only, 0 is diversity only. */
  mmrLambda: 0.7,
  /** Taken off a candidate for each pick already made in its category. */
  categoryPenalty: 0.04,
  /** Cosine at which the reason may name a liked place ("close") and at which the word becomes "very close", as in search. */
  anchorClose: 0.45,
  anchorVeryClose: 0.6,
  /** Cold start: how much a place with a tag the group likes is worth, against 1 for the city's best-ranked place. */
  coldTagBoost: 0.5,
  /** Tags from votes and plans in the trip's other cities count this much against ones from this city. */
  otherCityShare: 0.5,
  /** The reason may say "your group likes <tag>" for this many tags at most. */
  likedTagsMax: 2,
} as const;
export type Tuning = { -readonly [K in keyof typeof TUNING]: number };

// --- vectors ---------------------------------------------------------------------------------------

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** A unit-length copy; the zero vector stays zero. */
export function unit(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i]! * out[i]!;
  if (sum === 0) return out;
  const scale = 1 / Math.sqrt(sum);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! * scale;
  return out;
}

// --- signals ---------------------------------------------------------------------------------------

/** One place the group has an opinion about, with how strongly. */
export interface Signal {
  id: string;
  title: string;
  category: string | null;
  tags: string[];
  /** Positive: liked. Negative: voted down. */
  weight: number;
  /** Members who voted it up / down. */
  voters: number;
  downVoters: number;
  votedBy: string[];
  planned: boolean;
  comments: number;
  /** Unit vector, or null when this place has none (the group's own idea the embed run did not cover). */
  vector: Float32Array | null;
}

/**
 * What the group's votes, plans and comments say about the places in one city. Each member's votes share one unit of
 * influence (a vote counts 1 / sqrt(how many places that member voted on), so one person voting on everything does not
 * outweigh three people voting on a few), a plan counts `planWeight`, a comment a little. Places with no net signal are dropped.
 */
export function buildSignals(rows: CityActivity[], vectorOf: (id: string) => Float32Array | null, tuning: Tuning = TUNING): Signal[] {
  const votesCast = new Map<string, number>();
  for (const row of rows) for (const v of row.votes) if (v.value !== 0) votesCast.set(v.userId, (votesCast.get(v.userId) ?? 0) + 1);
  const share = (userId: string) => 1 / Math.sqrt(votesCast.get(userId) ?? 1);

  const signals: Signal[] = [];
  for (const row of rows) {
    let up = 0;
    let down = 0;
    const votedBy: string[] = [];
    let downVoters = 0;
    for (const v of row.votes) {
      if (v.value > 0) {
        up += share(v.userId);
        votedBy.push(v.userId);
      } else if (v.value < 0) {
        down += share(v.userId);
        downVoters++;
      }
    }
    const planned = row.planCount > 0;
    const comments = up - down >= 0 ? Math.min(row.commentCount, tuning.commentCap) : 0;
    const weight = up - down + (planned ? tuning.planWeight : 0) + comments * tuning.commentWeight;
    if (Math.abs(weight) < 1e-9) continue;
    signals.push({
      id: row.id,
      title: row.title,
      category: row.category,
      tags: row.tags,
      weight,
      voters: votedBy.length,
      downVoters,
      votedBy,
      planned,
      comments: row.commentCount,
      vector: vectorOf(row.id),
    });
  }
  return signals.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

export interface Taste {
  /** Unit vector: the liked places' weighted average, minus `dislikeLambda` times the disliked places' weighted average. */
  vector: Float32Array;
  liked: Signal[];
  disliked: Signal[];
}

/** The group's taste in this city, or null when no liked place has a vector. */
export function buildTaste(signals: Signal[], tuning: Tuning = TUNING): Taste | null {
  const liked = signals.filter((s) => s.weight > 0 && s.vector);
  if (!liked.length) return null;
  const disliked = signals.filter((s) => s.weight < 0 && s.vector);
  const dims = liked[0]!.vector!.length;
  const sum = new Float32Array(dims);
  let total = 0;
  for (const s of liked) {
    total += s.weight;
    for (let i = 0; i < dims; i++) sum[i] = sum[i]! + s.weight * s.vector![i]!;
  }
  const mean = sum.map((x) => x / total);
  if (disliked.length) {
    let down = 0;
    const away = new Float32Array(dims);
    for (const s of disliked) {
      down += -s.weight;
      for (let i = 0; i < dims; i++) away[i] = away[i]! + -s.weight * s.vector![i]!;
    }
    for (let i = 0; i < dims; i++) mean[i] = mean[i]! - (tuning.dislikeLambda * away[i]!) / down;
  }
  const vector = unit(mean);
  // A taste that cancels out (liked and disliked the same thing) falls back to the plain average of what was liked.
  const usable = vector.some((x) => x !== 0) ? vector : unit(sum);
  return { vector: usable, liked, disliked };
}

// --- tags ------------------------------------------------------------------------------------------

/** The colour tags the group likes, best first: this city's liked places count fully, other cities' votes and plans a share. */
export function likedTags(signals: Signal[], others: TagWeight[], tuning: Tuning = TUNING): TagWeight[] {
  const totals = new Map<string, number>();
  for (const s of signals) if (s.weight > 0) for (const tag of s.tags) totals.set(tag, (totals.get(tag) ?? 0) + s.weight);
  for (const o of others) if (o.weight > 0) totals.set(o.tag, (totals.get(o.tag) ?? 0) + tuning.otherCityShare * o.weight);
  return [...totals].map(([tag, weight]) => ({ tag, weight })).sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag));
}

// --- ranking ---------------------------------------------------------------------------------------

export interface Candidate {
  row: CityActivity;
  /** Unit vector, or null when the place has none. */
  vector: Float32Array | null;
  /** 1 = the city's best-ranked place of its category. */
  categoryRank: number | null;
}

export interface Scored {
  candidate: Candidate;
  relevance: number;
  anchor: Signal | null;
  anchorSim: number | null;
  tag: string | null;
}

/** Relevance to the taste: the blend of the average-taste similarity and the nearest liked place's, plus a small prior. */
export function scoreByTaste(c: Candidate, taste: Taste, tuning: Tuning = TUNING): Scored | null {
  const v = c.vector;
  if (!v) return null;
  for (const d of taste.disliked) if (dot(v, d.vector!) >= tuning.nearDuplicateOfDisliked) return null;
  // Relevance uses the nearest liked place of any kind. The place the reason names prefers one the group voted for or planned:
  // "similar to X, which 3 of you voted for" says more than "which your group commented on".
  let anchor: Signal | null = null;
  let anchorSim = -Infinity;
  let firm: Signal | null = null;
  let firmSim = -Infinity;
  for (const s of taste.liked) {
    const sim = dot(v, s.vector!);
    // Strictly greater: liked places are sorted by weight, so a tie keeps the one the group cares about most.
    if (sim > anchorSim) {
      anchor = s;
      anchorSim = sim;
    }
    if ((s.voters > 0 || s.planned) && sim > firmSim) {
      firm = s;
      firmSim = sim;
    }
  }
  const named = firm && firmSim >= tuning.anchorClose ? { signal: firm, sim: firmSim } : { signal: anchor, sim: anchorSim };
  const centroid = dot(v, taste.vector);
  const relevance = tuning.centroidShare * centroid + (1 - tuning.centroidShare) * anchorSim + tuning.priorWeight * prior(c.row.rank);
  return { candidate: c, relevance, anchor: named.signal, anchorSim: named.sim, tag: null };
}

/** Cold start: the city's own ranking, leaning toward places that carry a tag the group likes. */
export function scoreCold(c: Candidate, tags: TagWeight[], tuning: Tuning = TUNING): Scored {
  const top = tags[0]?.weight ?? 0;
  let share = 0;
  let tag: string | null = null;
  if (top > 0) {
    for (const t of tags) {
      if (t.weight <= 0 || !c.row.tags.includes(t.tag)) continue;
      if (t.weight / top > share) {
        share = t.weight / top;
        tag = t.tag;
      }
    }
  }
  return { candidate: c, relevance: prior(c.row.rank) + tuning.coldTagBoost * share, anchor: null, anchorSim: null, tag };
}

/**
 * Maximal marginal relevance: repeatedly take the candidate with the best relevance minus its similarity to what is already
 * picked, and a small charge for each pick in its category. Near-duplicates and ten-of-one-category lists lose to the next
 * different place. Deterministic: ties go to the better relevance, then the id.
 */
export function selectMmr(scored: Scored[], k: number, tuning: Tuning = TUNING): Scored[] {
  const pool = [...scored].sort((a, b) => b.relevance - a.relevance || a.candidate.row.id.localeCompare(b.candidate.row.id));
  const picked: Scored[] = [];
  const categoryCount = new Map<string, number>();
  while (picked.length < k && pool.length) {
    let best = -1;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      let redundancy = 0;
      for (const p of picked) {
        if (c.candidate.vector && p.candidate.vector) redundancy = Math.max(redundancy, dot(c.candidate.vector, p.candidate.vector));
      }
      const category = c.candidate.row.category;
      const crowded = category ? (categoryCount.get(category) ?? 0) : 0;
      const value = tuning.mmrLambda * c.relevance - (1 - tuning.mmrLambda) * redundancy - tuning.categoryPenalty * crowded;
      // The pool is sorted by relevance, so a strictly greater value keeps the better relevance on a tie.
      if (value > bestValue) {
        bestValue = value;
        best = i;
      }
    }
    const [chosen] = pool.splice(best, 1);
    picked.push(chosen!);
    const category = chosen!.candidate.row.category;
    if (category) categoryCount.set(category, (categoryCount.get(category) ?? 0) + 1);
  }
  return picked;
}

/** Where each candidate stands in its own category in the city (1 = best): from the catalogue rank, for the reason line. */
export function categoryRanks(rows: CityActivity[]): Map<string, number> {
  const byCategory = new Map<string, CityActivity[]>();
  for (const r of rows) {
    if (!r.catalogue || !r.listed || r.rank == null || !r.category) continue;
    byCategory.set(r.category, [...(byCategory.get(r.category) ?? []), r]);
  }
  const out = new Map<string, number>();
  for (const list of byCategory.values()) {
    list.sort((a, b) => a.rank! - b.rank! || a.id.localeCompare(b.id));
    list.forEach((r, i) => out.set(r.id, i + 1));
  }
  return out;
}

// --- the whole thing -------------------------------------------------------------------------------

export interface SuggestInput {
  cityName: string;
  /** Every visible activity of the trip in the stop's city. */
  rows: CityActivity[];
  /** The colour tags liked in the trip's other cities. */
  otherTags: TagWeight[];
  /** The place's unit vector, or null (no vectors loaded, or this place has none). */
  vectorOf: (id: string) => Float32Array | null;
  /** The member asking, so the reason can say "you voted for". */
  userId: string;
  limit: number;
  bestTime?: string | undefined;
  indoor?: boolean | undefined;
}

export interface SuggestionPick {
  row: CityActivity;
  because: "similar" | "tag" | "rank";
  anchor: Signal | null;
  anchorSim: number | null;
  reason: Reason;
}

export interface Suggested {
  basis: SuggestionBasis;
  picks: SuggestionPick[];
  likedTags: string[];
  liked: number;
  disliked: number;
  members: number;
  /** Places that could have been suggested before the limit: catalogue, listed, nobody voted, planned or commented on, and the filters. */
  candidates: number;
}

/** A catalogue place nobody in the group has touched yet. */
export const isFresh = (r: CityActivity) => r.catalogue && r.listed && !r.votes.length && r.planCount === 0 && r.commentCount === 0;

export function suggestForCity(input: SuggestInput, tuning: Tuning = TUNING): Suggested {
  const { rows } = input;
  const signals = buildSignals(rows, input.vectorOf, tuning);
  const taste = buildTaste(signals, tuning);
  const tags = likedTags(signals, input.otherTags, tuning);
  const ranks = categoryRanks(rows);
  const members = new Set(rows.flatMap((r) => r.votes.map((v) => v.userId))).size;

  const wanted = (r: CityActivity) =>
    isFresh(r) &&
    (input.bestTime == null || r.bestTime === input.bestTime || r.bestTime === "any") &&
    (input.indoor == null || r.indoor === input.indoor);
  const candidates: Candidate[] = rows.filter(wanted).map((row) => ({ row, vector: input.vectorOf(row.id), categoryRank: ranks.get(row.id) ?? null }));

  let basis: SuggestionBasis;
  let scored: Scored[];
  const byTaste = taste ? candidates.map((c) => scoreByTaste(c, taste, tuning)).filter((s): s is Scored => s !== null) : [];
  if (taste && byTaste.length) {
    basis = "group_taste";
    scored = byTaste;
  } else {
    basis = tags.some((t) => t.weight > 0) ? "tag_preferences" : "catalogue_rank";
    scored = candidates.map((c) => scoreCold(c, tags, tuning));
  }

  const likedNames = tags.filter((t) => t.weight > 0).slice(0, tuning.likedTagsMax).map((t) => t.tag);
  const picks = selectMmr(scored, input.limit, tuning).map((s): SuggestionPick => {
    const reason = explain({
      basis,
      row: s.candidate.row,
      cityName: input.cityName,
      categoryRank: s.candidate.categoryRank,
      anchor: s.anchor,
      anchorSim: s.anchorSim,
      likedTags: likedNames,
      userId: input.userId,
      tuning,
    });
    return { row: s.candidate.row, because: reason.because, anchor: reason.anchor, anchorSim: reason.anchor ? s.anchorSim : null, reason };
  });
  return {
    basis,
    picks,
    likedTags: basis === "catalogue_rank" ? [] : likedNames,
    liked: signals.filter((s) => s.weight > 0).length,
    disliked: signals.filter((s) => s.weight < 0).length,
    members,
    candidates: candidates.length,
  };
}
