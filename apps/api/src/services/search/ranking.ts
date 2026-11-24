import type { SearchMatch } from "@trippr/contracts";
import type { SearchCandidate } from "../../repositories/search";

/**
 * Hybrid ranking, with no database in it: a lexical score from the words, the vector similarity when there is
 * one, and a small prior from the city's own ranking of the place. Pure functions so every rule has a test.
 */

/** Weights of the final score. Vectors lead; an exact name match must still win over a merely similar place. */
export const WEIGHTS = { semantic: 0.55, lexical: 0.4, prior: 0.05 } as const;
/** Cosine below FLOOR counts for nothing; at CEIL it counts in full. BGE-M3's unrelated pairs sit near 0.3. */
export const SIM_FLOOR = 0.3;
export const SIM_CEIL = 0.75;
/**
 * Added when the question is, or sits inside, the place's name (lexical >= 0.9): someone who types a place's name wants
 * that place first, even when its vector is missing or an unrelated place happens to be close to the question.
 */
export const NAME_BONUS = 0.2;
export const NAME_EXACT = 0.9;
/** A lexical score at or above this is "the words match this place's name". */
export const NAME_MATCH = 0.6;

const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "of", "for", "to", "and", "or", "with", "near", "by", "from", "around", "best", "good", "some", "any", "me", "my", "our",
]);

/** Lower case, accents folded, width variants unified; keeps letters and numbers of every script. */
export function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** Crude plural folding ("temples" finds "temple"); other languages pass through. */
function stem(token: string): string {
  if (/^[a-z]+$/.test(token) && token.length > 3) {
    if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
    if (/(ches|shes|sses|xes)$/.test(token)) return token.slice(0, -2);
    if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  }
  return token;
}

/** The words of a question: folded, stop words and one-letter Latin words removed, plurals folded. */
export function tokens(query: string): string[] {
  const words = fold(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = words.filter((w) => !STOP_WORDS.has(w) && !(w.length === 1 && /^[a-z0-9]$/.test(w)));
  return [...new Set((kept.length ? kept : words).map(stem))];
}

/** The tokens as the database query wants them (lower case only; the database cannot fold accents). */
export function dbTokens(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = words.filter((w) => !STOP_WORDS.has(w) && !(w.length === 1 && /^[a-z0-9]$/.test(w)));
  return [...new Set([...(kept.length ? kept : words).map(stem), ...tokens(query)])].slice(0, 8);
}

const fraction = (found: number, of: number) => (of === 0 ? 0 : found / of);

/**
 * How well the words of a question match a place, 0 to 1: the whole question equal to a name 1; contained in a name
 * 0.9; each word found in a name, scaled to 0.8; in the address or category 0.4; in the city's name 0.3.
 */
export function lexicalScore(query: string, c: Pick<SearchCandidate, "title" | "nameLocal" | "address" | "category" | "cityName">): number {
  const words = tokens(query);
  if (!words.length) return 0;
  const phrase = fold(query).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const names = [c.title, c.nameLocal].filter((n): n is string => Boolean(n)).map((n) => fold(n).replace(/[^\p{L}\p{N}]+/gu, " ").trim());
  let best = 0;
  for (const name of names) {
    if (name === phrase) return 1;
    if (phrase.length >= 2 && name.includes(phrase)) best = Math.max(best, 0.9);
    const found = words.filter((w) => name.includes(w)).length;
    best = Math.max(best, 0.8 * fraction(found, words.length));
  }
  const address = fold(c.address ?? "");
  const category = fold(c.category ?? "").replace(/_/g, " ");
  const city = fold(c.cityName);
  const outside = (text: string, weight: number) => weight * fraction(words.filter((w) => text.includes(w)).length, words.length);
  // The place's name is the strongest signal; address, category and city only add up when the name has nothing.
  const context = Math.min(0.5, outside(address, 0.4) + outside(category, 0.4) + outside(city, 0.3));
  return Math.max(best, context);
}

/** 1 for the city's best place, falling slowly: a tie-breaker, never a reason to appear. */
export function prior(rank: number | null): number {
  return rank == null || rank < 1 ? 0 : 1 / (1 + Math.log2(rank));
}

export function semanticPart(similarity: number | null): number {
  if (similarity == null) return 0;
  return Math.min(1, Math.max(0, (similarity - SIM_FLOOR) / (SIM_CEIL - SIM_FLOOR)));
}

export interface Scored {
  candidate: SearchCandidate;
  similarity: number | null;
  lexical: number;
  score: number;
  match: SearchMatch;
  reason: string;
  distanceKm: number | null;
}

/** Combine one candidate's signals. In lexical mode (`vectors` false) the weights fold into the words. */
export function combine(
  candidate: SearchCandidate,
  signals: { similarity: number | null; lexical: number; distanceKm: number | null },
  vectors: boolean,
): Scored {
  const semantic = vectors ? semanticPart(signals.similarity) : 0;
  const p = prior(candidate.rank);
  const score = vectors
    ? WEIGHTS.semantic * semantic + WEIGHTS.lexical * signals.lexical + WEIGHTS.prior * p + (signals.lexical >= NAME_EXACT ? NAME_BONUS : 0)
    : 0.95 * signals.lexical + 0.05 * p;
  const byName = signals.lexical >= NAME_MATCH;
  const byMeaning = semantic >= 0.3;
  const match: SearchMatch = byName && byMeaning ? "both" : byName ? "name" : byMeaning ? "meaning" : "words";
  return {
    candidate,
    similarity: signals.similarity,
    lexical: signals.lexical,
    score,
    match,
    reason: reasonFor(match, signals.similarity, vectors),
    distanceKm: signals.distanceKm,
  };
}

function reasonFor(match: SearchMatch, similarity: number | null, vectors: boolean): string {
  const percent = similarity == null ? "" : ` (${Math.round(Math.max(0, similarity) * 100)}% similar)`;
  if (!vectors) return match === "name" ? "The name matches your words" : "Your words appear in its details";
  switch (match) {
    case "both":
      return `The name matches and the meaning is close${percent}`;
    case "name":
      return "The name matches your words";
    case "meaning":
      return `Similar in meaning to your search${percent}`;
    default:
      return "Your words appear in its details";
  }
}

/** Best first; ties by the city's rank, then id, so a page never reshuffles between requests. */
export function byScore(a: Scored, b: Scored): number {
  return b.score - a.score || (a.candidate.rank ?? 1e9) - (b.candidate.rank ?? 1e9) || a.candidate.id.localeCompare(b.candidate.id);
}

/** Great-circle distance in kilometres. */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A result is worth showing when its words match, or when its meaning is close enough to count. Without this,
 * "nearest 20 of 8,000" would always return 20 places, however unrelated.
 */
export function worthShowing(s: Scored, vectors: boolean): boolean {
  return s.lexical > 0 || (vectors && semanticPart(s.similarity) > 0);
}
