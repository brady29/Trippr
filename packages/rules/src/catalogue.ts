/**
 * Catalogue rules: how a place loaded from the data pipeline's bundle relates to the activities the group
 * wrote by hand (docs/data-platform-spec.md, "Ranking and curation": hand-written activities win when they
 * match). Pure functions, shared by the load job and the web app's labels.
 */
import { distanceKm } from "./travel";

/** Activity ids of catalogue places start with this; hand-written ones ("act-...") never do. */
export const CATALOGUE_ID_PREFIX = "cat-";
export const isCatalogueId = (id: string) => id.startsWith(CATALOGUE_ID_PREFIX);

const STOP_WORDS = new Set(["the", "a", "an", "of", "and", "at", "in", "de", "la", "le"]);

/**
 * A comparison key for a place name: Unicode NFKC, lower case, punctuation dropped, words in sorted order,
 * without articles and the words in `drop` (usually the city's name). "Shibuya Sky" and "SHIBUYA  SKY!"
 * give the same key; "teamLab Planets TOKYO" gives "planets teamlab" for the city "Tokyo".
 * Names with no letters or digits give "".
 */
export function titleKey(text: string, drop: readonly string[] = []): string {
  const dropped = new Set(drop.flatMap((d) => words(d)));
  const kept = words(text).filter((w) => !STOP_WORDS.has(w) && !dropped.has(w));
  return kept.sort().join(" ");
}

function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

export interface HandWrittenActivity {
  id: string;
  cityCode: string;
  cityName: string;
  title: string;
  /** What to search on Google Maps, often the venue's real name. */
  mapsQuery?: string | null;
  lat?: number | null;
  lon?: number | null;
}

export interface CatalogueCandidate {
  id: string;
  cityCode: string;
  /** name, name_en and name_local. */
  names: string[];
  lat: number;
  lon: number;
  /** 1 = the city's best place. */
  rank: number;
}

/** A hand-written activity that already has a pin must be this close to the catalogue place to be the same place. */
export const ADOPT_MAX_KM = 0.5;

/**
 * Which catalogue places are the group's own activities. Conservative on purpose (a wrong match would
 * move someone's idea onto another place): the same city, and the title or the Maps query has the same
 * key as one of the place's names, and if the activity is already pinned the pin is within 500 m.
 * Each activity and each place is used once; when several places fit, the better-ranked one wins.
 */
export function planAdoptions(
  activities: readonly HandWrittenActivity[],
  places: readonly CatalogueCandidate[],
): { activityId: string; placeId: string }[] {
  const inCity = new Map<string, CatalogueCandidate[]>();
  for (const place of places) inCity.set(place.cityCode, [...(inCity.get(place.cityCode) ?? []), place]);
  const keysOf = (texts: readonly (string | null | undefined)[], cityName: string) =>
    new Set(texts.flatMap((t) => (t ? [titleKey(t), titleKey(t, [cityName])] : [])).filter(Boolean));

  const taken = new Set<string>();
  const out: { activityId: string; placeId: string }[] = [];
  for (const activity of [...activities].sort((a, b) => a.id.localeCompare(b.id))) {
    const wanted = keysOf([activity.title, activity.mapsQuery], activity.cityName);
    const pin = activity.lat != null && activity.lon != null ? { lat: activity.lat, lon: activity.lon } : null;
    const best = (inCity.get(activity.cityCode) ?? [])
      .filter((p) => !taken.has(p.id))
      .filter((p) => [...keysOf(p.names, activity.cityName)].some((k) => wanted.has(k)))
      .filter((p) => !pin || distanceKm(pin, p) <= ADOPT_MAX_KM)
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))[0];
    if (best) {
      taken.add(best.id);
      out.push({ activityId: activity.id, placeId: best.id });
    }
  }
  return out;
}
