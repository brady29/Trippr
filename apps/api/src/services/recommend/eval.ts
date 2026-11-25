import type { CityActivity } from "../../repositories/recommend";
import { TUNING, dot, isFresh, suggestForCity, type Tuning } from "./core";

/**
 * Offline evaluation of "Suggested for this stop" without a live group. It calls `suggestForCity`, the function the API
 * calls, over a catalogue (a bundle's places and their vectors), so it measures what the app does.
 *
 * What is real and what is made up. The places, their categories, ranks and vectors are the catalogue's. The GROUPS are
 * synthetic: a profile is "this group likes <one or two categories> in <city>", the liked places are sampled from the
 * catalogue, and the votes are simulated (each liked place gets one to three of three members, some are planned). Leave-one-out
 * then hides one liked place and asks whether it comes back among the suggestions. Because a category is part of the text a
 * place's vector is made from, this protocol favours the vector methods over the baselines by construction; it shows that the
 * taste signal is picked up, that diversity and the exclusions work, and it catches regressions. It does not show that real
 * groups would like the suggestions: only live votes can.
 */

export interface EvalPlace {
  id: string;
  title: string;
  city: string;
  category: string;
  tag: string;
  rank: number;
  sitelinks: number;
  nSources: number;
  bestTime: string | null;
  indoor: boolean | null;
  /** Unit vector. */
  vector: Float32Array;
}

export interface EvalOptions {
  /** Hit rate and the other list metrics are taken at this depth. */
  k: number;
  /** Lists are cut here; a hidden place beyond it counts as a miss (MRR@maxRank). */
  maxRank: number;
  seed: number;
  /** Cities with fewer places are skipped. */
  minCityPlaces: number;
  profilesPerCity: number;
  repeats: number;
  likedPerProfile: number;
  members: number;
  /** Stop after this many cities (largest first); 0 = all. */
  maxCities: number;
}

export const DEFAULT_EVAL: EvalOptions = {
  k: 10,
  maxRank: 20,
  seed: 20261125,
  minCityPlaces: 25,
  profilesPerCity: 4,
  repeats: 2,
  likedPerProfile: 6,
  members: 3,
  maxCities: 0,
};

/** A small seeded generator so a run can be repeated exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// --- profiles --------------------------------------------------------------------------------------

export interface Profile {
  city: string;
  categories: string[];
  /** Liked places with the members who voted them up and whether the group planned them. */
  liked: { place: EvalPlace; voters: string[]; planned: boolean }[];
}

/** The profiles of one city: the biggest categories one at a time, and one mixed pair of the next two. */
export function profilesFor(city: string, places: EvalPlace[], options: EvalOptions, random: () => number): Profile[] {
  const byCategory = new Map<string, EvalPlace[]>();
  for (const p of places) byCategory.set(p.category, [...(byCategory.get(p.category) ?? []), p]);
  const sorted = [...byCategory].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const wanted: string[][] = [];
  const single = options.likedPerProfile + 2;
  const half = Math.ceil(options.likedPerProfile / 2) + 1;
  for (const [category, list] of sorted) if (list.length >= single && wanted.length < options.profilesPerCity - 1) wanted.push([category]);
  const rest = sorted.filter(([, list]) => list.length >= half).map(([c]) => c);
  for (let i = 0; i + 1 < rest.length && wanted.length < options.profilesPerCity; i += 2) wanted.push([rest[i]!, rest[i + 1]!]);

  const members = Array.from({ length: options.members }, (_, i) => `m${i + 1}`);
  const profiles: Profile[] = [];
  for (const categories of wanted) {
    for (let r = 0; r < options.repeats; r++) {
      const perCategory = Math.ceil(options.likedPerProfile / categories.length);
      const picked = categories.flatMap((c) => shuffled(byCategory.get(c)!, random).slice(0, perCategory)).slice(0, options.likedPerProfile);
      profiles.push({
        city,
        categories,
        liked: picked.map((place) => {
          // One to three members up-vote it (half the time one, 30% two, 20% all), and about one in three is planned.
          const roll = random();
          const n = roll < 0.5 ? 1 : roll < 0.8 ? Math.min(2, members.length) : members.length;
          return { place, voters: shuffled(members, random).slice(0, n), planned: random() < 1 / 3 };
        }),
      });
    }
  }
  return profiles;
}

// --- rows ------------------------------------------------------------------------------------------

const rowOf = (p: EvalPlace): CityActivity => ({
  id: p.id,
  title: p.title,
  catalogue: true,
  listed: true,
  category: p.category,
  rank: p.rank,
  score: null,
  bestTime: p.bestTime,
  indoor: p.indoor,
  votes: [],
  planCount: 0,
  commentCount: 0,
  tags: [p.tag],
});

/** The city's rows with the profile's votes on them, except `hidden` (left as an untouched catalogue place). */
export function rowsFor(places: EvalPlace[], profile: Profile | null, hidden: string | null): CityActivity[] {
  const liked = new Map(profile?.liked.map((l) => [l.place.id, l]) ?? []);
  return places.map((p) => {
    const row = rowOf(p);
    const l = liked.get(p.id);
    if (l && p.id !== hidden) {
      row.votes = l.voters.map((userId) => ({ userId, value: 1 }));
      row.planCount = l.planned ? 1 : 0;
    }
    return row;
  });
}

// --- methods ---------------------------------------------------------------------------------------

export interface Case {
  profile: Profile;
  hidden: EvalPlace;
  rows: CityActivity[];
  places: EvalPlace[];
}

export type Method = { name: string; run: (c: Case, random: () => number) => string[] };

const pool = (c: Case) => c.rows.filter(isFresh);

export function viaCore(name: string, tuning: Tuning, limit: number): Method {
  return {
    name,
    run: (c) => {
      const byId = new Map(c.places.map((p) => [p.id, p.vector]));
      return suggestForCity({ cityName: c.profile.city, rows: c.rows, otherTags: [], vectorOf: (id) => byId.get(id) ?? null, userId: "m1", limit }, tuning).picks.map((p) => p.row.id);
    },
  };
}

export function methods(options: EvalOptions): Method[] {
  const cut = (ids: string[]) => ids.slice(0, options.maxRank);
  const byId = (c: Case) => new Map(c.places.map((p) => [p.id, p]));
  const n = options.maxRank;
  return [
    viaCore("group taste + MMR (shipped)", { ...TUNING }, n),
    viaCore("group taste, no diversity", { ...TUNING, mmrLambda: 1, categoryPenalty: 0 }, n),
    viaCore("average taste only (+MMR)", { ...TUNING, centroidShare: 1 }, n),
    viaCore("nearest liked place only (+MMR)", { ...TUNING, centroidShare: 0 }, n),
    {
      name: "baseline: catalogue rank",
      run: (c) => cut(pool(c).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.id.localeCompare(b.id)).map((r) => r.id)),
    },
    {
      name: "baseline: notability",
      run: (c) => {
        const places = byId(c);
        const key = (id: string) => places.get(id)!;
        return cut(
          pool(c)
            .map((r) => r.id)
            .sort((a, b) => key(b).sitelinks - key(a).sitelinks || key(b).nSources - key(a).nSources || key(a).rank - key(b).rank || a.localeCompare(b)),
        );
      },
    },
    {
      name: "baseline: random",
      run: (c, random) => cut(shuffled(pool(c).map((r) => r.id), random)),
    },
  ];
}

// --- metrics ---------------------------------------------------------------------------------------

export interface ListMetrics {
  hit1: number;
  hit5: number;
  hit10: number;
  mrr: number;
  categories: number;
  profileShare: number;
  bothKinds: number | null;
  redundancy: number;
}

function listMetrics(ids: string[], c: Case, options: EvalOptions): ListMetrics {
  const at = ids.indexOf(c.hidden.id);
  const top = ids.slice(0, options.k);
  const byId = new Map(c.places.map((p) => [p.id, p]));
  const placesTop = top.map((id) => byId.get(id)!).filter(Boolean);
  const inProfile = placesTop.filter((p) => c.profile.categories.includes(p.category)).length;
  let pairs = 0;
  let total = 0;
  for (let i = 0; i < placesTop.length; i++) {
    for (let j = i + 1; j < placesTop.length; j++) {
      total += dot(placesTop[i]!.vector, placesTop[j]!.vector);
      pairs++;
    }
  }
  const kinds = new Set(placesTop.map((p) => p.category));
  return {
    hit1: at >= 0 && at < 1 ? 1 : 0,
    hit5: at >= 0 && at < 5 ? 1 : 0,
    hit10: at >= 0 && at < options.k ? 1 : 0,
    mrr: at >= 0 && at < options.maxRank ? 1 / (at + 1) : 0,
    categories: kinds.size,
    profileShare: placesTop.length ? inProfile / placesTop.length : 0,
    bothKinds: c.profile.categories.length > 1 ? (c.profile.categories.every((k) => kinds.has(k)) ? 1 : 0) : null,
    redundancy: pairs ? total / pairs : 0,
  };
}

export interface MethodRow {
  method: string;
  cases: number;
  hit1: number;
  hit5: number;
  hit10: number;
  mrr: number;
  categories: number;
  profileShare: number;
  /** Mixed profiles only: how often the top k holds both of the profile's categories. */
  bothKinds: number | null;
  redundancy: number;
}

export interface Check {
  name: string;
  /** "invariant": must always hold, whatever the vectors. "quality": depends on how good the vectors are. */
  kind: "invariant" | "quality";
  ok: boolean;
  detail: string;
}

export interface ColdStart {
  cities: number;
  /** Mean overlap of the top k with the catalogue's own top k (1 = identical; diversity swaps some out). */
  overlapWithRank: number;
  /** Share of the picks that sit inside the catalogue's own top 3k. */
  withinTop3k: number;
  /** With one tag liked elsewhere: the share of the top k carrying it, against the share in the catalogue's top k. */
  tagShareWithTags: number;
  tagShareWithoutTags: number;
  basisWithoutSignals: string[];
  basisWithTags: string[];
  explained: number;
}

export interface EvalReport {
  options: EvalOptions;
  cities: number;
  profiles: number;
  cases: number;
  places: number;
  rows: MethodRow[];
  checks: Check[];
  coldStart: ColdStart;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export function runEval(allPlaces: EvalPlace[], partial: Partial<EvalOptions> = {}, extra: Method[] = []): EvalReport {
  const options = { ...DEFAULT_EVAL, ...partial };
  const random = mulberry32(options.seed);
  const byCity = new Map<string, EvalPlace[]>();
  for (const p of allPlaces) byCity.set(p.city, [...(byCity.get(p.city) ?? []), p]);
  let cityList = [...byCity].filter(([, ps]) => ps.length >= options.minCityPlaces).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (options.maxCities > 0) cityList = cityList.slice(0, options.maxCities);

  const all = [...methods(options), ...extra];
  const results = new Map<string, ListMetrics[]>(all.map((m) => [m.name, []]));
  const violations = { engaged: 0, picks: 0, unexplained: 0, reasons: 0, wrongAnchor: 0, similar: 0, number: 0, unstable: 0, determinismChecked: 0, shortLists: 0, lists: 0 };
  let profiles = 0;
  let cases = 0;

  for (const [city, places] of cityList) {
    for (const profile of profilesFor(city, places, options, random)) {
      profiles++;
      for (const liked of profile.liked) {
        const c: Case = { profile, hidden: liked.place, rows: rowsFor(places, profile, liked.place.id), places };
        cases++;
        for (const m of all) {
          const ids = m.run(c, random);
          results.get(m.name)!.push(listMetrics(ids, c, options));
        }

        // Checks on the shipped method's own output.
        const byId = new Map(places.map((p) => [p.id, p.vector]));
        const input = { cityName: city, rows: c.rows, otherTags: [], vectorOf: (id: string) => byId.get(id) ?? null, userId: "m1", limit: options.maxRank };
        const out = suggestForCity(input);
        violations.lists++;
        if (out.picks.length < Math.min(options.k, out.candidates)) violations.shortLists++;
        const stillLiked = new Map(profile.liked.filter((l) => l.place.id !== liked.place.id).map((l) => [l.place.id, l]));
        for (const pick of out.picks) {
          violations.picks++;
          if (stillLiked.has(pick.row.id) || !isFresh(pick.row)) violations.engaged++;
          violations.reasons++;
          if (!pick.reason.text.trim()) violations.unexplained++;
          if (/%|\d\.\d|similarity|\bAI\b|language model|LLM/i.test(pick.reason.text)) violations.number++;
          if (pick.because === "similar") {
            violations.similar++;
            const truth = pick.reason.anchor ? stillLiked.get(pick.reason.anchor.id) : undefined;
            if (!truth || truth.voters.length !== pick.reason.anchor!.voters || truth.planned !== pick.reason.anchor!.planned) violations.wrongAnchor++;
          }
        }
        if (cases % 7 === 0) {
          violations.determinismChecked++;
          const again = suggestForCity({ ...input, rows: [...input.rows].reverse() });
          if (again.picks.map((p) => p.row.id).join() !== out.picks.map((p) => p.row.id).join()) violations.unstable++;
        }
      }
    }
  }

  const rows: MethodRow[] = all.map((m) => {
    const rs = results.get(m.name)!;
    const kinds = rs.filter((r) => r.bothKinds !== null).map((r) => r.bothKinds!);
    return {
      method: m.name,
      cases: rs.length,
      hit1: round(mean(rs.map((r) => r.hit1))),
      hit5: round(mean(rs.map((r) => r.hit5))),
      hit10: round(mean(rs.map((r) => r.hit10))),
      mrr: round(mean(rs.map((r) => r.mrr))),
      categories: round(mean(rs.map((r) => r.categories)), 2),
      profileShare: round(mean(rs.map((r) => r.profileShare))),
      bothKinds: kinds.length ? round(mean(kinds)) : null,
      redundancy: round(mean(rs.map((r) => r.redundancy))),
    };
  });

  // Cold start: no signals at all, then one liked tag from "other cities".
  const cold: ColdStart = { cities: 0, overlapWithRank: 0, withinTop3k: 0, tagShareWithTags: 0, tagShareWithoutTags: 0, basisWithoutSignals: [], basisWithTags: [], explained: 1 };
  const overlaps: number[] = [];
  let coldRanked = 0;
  let coldNear = 0;
  const withTags: number[] = [];
  const without: number[] = [];
  let coldPicks = 0;
  let coldExplained = 0;
  for (const [city, places] of cityList) {
    const rowsNone = rowsFor(places, null, null);
    const byId = new Map(places.map((p) => [p.id, p.vector]));
    const base = { cityName: city, rows: rowsNone, vectorOf: (id: string) => byId.get(id) ?? null, userId: "m1", limit: options.k };
    const none = suggestForCity({ ...base, otherTags: [] });
    const top = [...places].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)).slice(0, options.k).map((p) => p.id);
    overlaps.push(top.filter((id) => none.picks.some((p) => p.row.id === id)).length / Math.max(1, top.length));
    const tagCounts = new Map<string, number>();
    for (const p of places) tagCounts.set(p.tag, (tagCounts.get(p.tag) ?? 0) + 1);
    const liked = [...tagCounts].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).find(([, n]) => n >= options.k)?.[0];
    for (const p of none.picks) {
      coldRanked++;
      if (p.row.rank != null && p.row.rank <= 3 * options.k) coldNear++;
    }
    cold.basisWithoutSignals.push(none.basis);
    if (liked) {
      const tagged = suggestForCity({ ...base, otherTags: [{ tag: liked, weight: 5 }] });
      cold.basisWithTags.push(tagged.basis);
      const share = (ids: string[]) => ids.filter((id) => places.find((p) => p.id === id)?.tag === liked).length / Math.max(1, ids.length);
      withTags.push(share(tagged.picks.map((p) => p.row.id)));
      without.push(share(none.picks.map((p) => p.row.id)));
      for (const p of tagged.picks) {
        coldPicks++;
        if (p.reason.text.trim()) coldExplained++;
      }
    }
    for (const p of none.picks) {
      coldPicks++;
      if (p.reason.text.trim()) coldExplained++;
    }
  }
  cold.cities = cityList.length;
  cold.overlapWithRank = round(mean(overlaps));
  cold.withinTop3k = round(coldRanked ? coldNear / coldRanked : 1);
  cold.tagShareWithTags = round(mean(withTags));
  cold.tagShareWithoutTags = round(mean(without));
  cold.explained = coldPicks ? coldExplained / coldPicks : 1;

  const shipped = rows[0]!;
  const checks: Check[] = [
    { kind: "invariant", name: "no suggestion is already planned, voted, commented on or the group's own", ok: violations.engaged === 0, detail: `${violations.engaged} of ${violations.picks} suggestions` },
    { kind: "invariant", name: "every suggestion has a reason", ok: violations.unexplained === 0 && cold.explained === 1, detail: `${violations.reasons - violations.unexplained} of ${violations.reasons} (cold start: ${round(cold.explained * 100, 1)}%)` },
    { kind: "invariant", name: "a 'similar to' reason names a liked place with the right voters and plan", ok: violations.wrongAnchor === 0, detail: `${violations.similar - violations.wrongAnchor} of ${violations.similar}` },
    { kind: "invariant", name: "no reason shows a similarity number or credits a model", ok: violations.number === 0, detail: `${violations.number} found` },
    { kind: "invariant", name: "the same input gives the same list, whatever the row order", ok: violations.unstable === 0, detail: `${violations.determinismChecked - violations.unstable} of ${violations.determinismChecked} sampled cases` },
    { kind: "invariant", name: "a list is full whenever there are enough candidates", ok: violations.shortLists === 0, detail: `${violations.lists - violations.shortLists} of ${violations.lists}` },
    { kind: "invariant", name: "cold start without any signal is based on the catalogue's ranking alone", ok: cold.basisWithoutSignals.every((b) => b === "catalogue_rank"), detail: `basis catalogue_rank in ${cold.basisWithoutSignals.filter((b) => b === "catalogue_rank").length} of ${cold.basisWithoutSignals.length} cities` },
    { kind: "quality", name: "cold start stays near the top of the catalogue's ranking", ok: cold.withinTop3k >= 0.9, detail: `${round(cold.withinTop3k * 100, 1)}% of the picks are in the catalogue's top ${3 * options.k}; ${round(cold.overlapWithRank * 100, 1)}% of its top ${options.k} are kept (diversity swaps some out)` },
    { kind: "quality", name: "cold start with a liked tag leans toward that tag", ok: cold.basisWithTags.every((b) => b === "tag_preferences") && cold.tagShareWithTags >= cold.tagShareWithoutTags, detail: `share of the top ${options.k} with the tag: ${cold.tagShareWithTags} (${cold.tagShareWithoutTags} without)` },
    { kind: "quality", name: "the shipped method beats the baselines at hit@10", ok: rows.filter((r) => r.method.startsWith("baseline")).every((r) => shipped.hit10 >= r.hit10), detail: `${shipped.hit10} against ${rows.filter((r) => r.method.startsWith("baseline")).map((r) => `${r.method.replace("baseline: ", "")} ${r.hit10}`).join(", ")}` },
  ];

  return { options, cities: cityList.length, profiles, cases, places: allPlaces.length, rows, checks, coldStart: cold };
}

export function renderEval(report: EvalReport, title: string): string {
  const pct = (x: number) => x.toFixed(3);
  const lines = [
    title,
    "",
    `${report.cases} leave-one-out cases from ${report.profiles} synthetic group profiles in ${report.cities} cities (${report.places} places); hit rate and list metrics at k = ${report.options.k}, MRR cut at ${report.options.maxRank}.`,
    "",
    "| method | hit@1 | hit@5 | hit@10 | MRR@20 | categories in top 10 | share in profile categories | both kinds present | redundancy |",
    "|---|---|---|---|---|---|---|---|---|",
    ...report.rows.map(
      (r) => `| ${r.method} | ${pct(r.hit1)} | ${pct(r.hit5)} | ${pct(r.hit10)} | ${pct(r.mrr)} | ${r.categories.toFixed(2)} | ${pct(r.profileShare)} | ${r.bothKinds === null ? "n/a" : pct(r.bothKinds)} | ${pct(r.redundancy)} |`,
    ),
    "",
    "| check | kind | result | detail |",
    "|---|---|---|---|",
    ...report.checks.map((c) => `| ${c.name} | ${c.kind} | ${c.ok ? "pass" : "FAIL"} | ${c.detail} |`),
    "",
  ];
  return lines.join("\n");
}
