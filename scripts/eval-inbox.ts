/**
 * pnpm eval:inbox [--only <id>] [--no-lookup]
 *
 * Runs the inbox eval set (apps/api/test/fixtures/inbox-eval/*.json) against
 * the real Claude reader and place lookup, and prints field-level scores.
 * Run it by hand before changing the reader or the lookup. It calls the
 * Anthropic API (web search is billed per search), so it never runs in CI and
 * refuses to start without ANTHROPIC_API_KEY. No database, no geocoder.
 */
import {
  checkLookup,
  classifyLink,
  createClaudeLookup,
  createClaudeReader,
  findLinks,
  MAX_LOOKUPS_PER_MESSAGE,
  previewLinks,
  type ExtractedItem,
  type LookupCity,
  type ReaderContext,
} from "@trippr/api/inbox-eval";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = resolve(ROOT, "apps/api/test/fixtures/inbox-eval");

if (process.env.CI) {
  console.error("eval:inbox calls the Anthropic API and costs money; it never runs in CI.");
  process.exit(1);
}
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) {
  console.error("eval:inbox needs ANTHROPIC_API_KEY (in the environment or .env). Nothing was run.");
  process.exit(1);
}

// --- fixtures ------------------------------------------------------------------

interface ExpectedLookup {
  placeName?: string;
  websiteHost?: string;
  ticketHost?: string;
  reserveHost?: string;
  eventDate?: string;
  minConfidence?: "high" | "medium" | "low";
  /** A host that must not appear in any kept link (prompt-injection cases). */
  forbiddenHost?: string;
}

interface ExpectedItem {
  kind: "leg" | "stay" | "activity";
  title?: string;
  cityCode?: string;
  leg?: Record<string, string | number>;
  stay?: Record<string, string | number>;
  lookup?: ExpectedLookup;
}

interface Fixture {
  id: string;
  category: string;
  message: { from: string | null; subject: string | null; text: string };
  /** What the oEmbed preview would say for a link (the eval makes no oEmbed calls). */
  links?: { url: string; title?: string; author?: string }[];
  expected: ExpectedItem[];
}

const fixtures: Fixture[] = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .flatMap((f) => JSON.parse(readFileSync(resolve(FIXTURES, f), "utf8")) as Fixture[]);

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const withLookup = !args.includes("--no-lookup");
const selected = only ? fixtures.filter((f) => f.id === only) : fixtures;
if (!selected.length) {
  console.error(only ? `No fixture called ${only}.` : "No fixtures found.");
  process.exit(1);
}

// --- the trip context: the seeded cities and the main route ----------------------

const cities = JSON.parse(readFileSync(resolve(ROOT, "seed/cities.json"), "utf8")) as { code: string; name: string; country: string }[];
const countries = new Map(
  (JSON.parse(readFileSync(resolve(ROOT, "seed/countries.json"), "utf8")) as { iso: string; name: string }[]).map((c) => [c.iso, c.name]),
);
const route = JSON.parse(readFileSync(resolve(ROOT, "seed/main-route.json"), "utf8")) as { stops: { city: string; nights: number }[] };
const trip = JSON.parse(readFileSync(resolve(ROOT, "seed/trip.json"), "utf8")) as { startDate: string; travellers: number };

const readerCities = cities.map((c) => ({ code: c.code, name: c.name, countryName: countries.get(c.country) ?? c.country }));
const byCode = new Map(readerCities.map((c) => [c.code, c]));
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
let day = trip.startDate;
const stops = route.stops.map((s) => {
  const stop = { code: s.city, name: byCode.get(s.city)?.name ?? s.city, arrive: day, depart: addDays(day, s.nights) };
  day = stop.depart;
  return stop;
});
const ctx: ReaderContext = { cities: readerCities, stops, travellers: trip.travellers, today: new Date().toISOString().slice(0, 10) };
const routeCities: LookupCity[] = [...new Set(stops.map((s) => s.code))].map((c) => byCode.get(c)).filter((c): c is LookupCity => Boolean(c));
const known = new Set(readerCities.map((c) => c.code));

// --- scoring ---------------------------------------------------------------------

const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const similar = (a: unknown, b: unknown) => {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const words = new Set(y.split(" ").filter((w) => w.length >= 4));
  return x.split(" ").some((w) => w.length >= 4 && words.has(w));
};
const compact = (s: unknown) => String(s ?? "").replace(/\s+/g, "").toUpperCase();
const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};
const hostIs = (url: string | null | undefined, host: string) => {
  const h = hostOf(url);
  return h != null && (h === host || h.endsWith(`.${host}`));
};
const near = (a: unknown, b: number, tolerance: number) => typeof a === "number" && Math.abs(a - b) <= Math.max(1, b * tolerance);
const RANK = { low: 0, medium: 1, high: 2 } as const;

const scores = new Map<string, { ok: number; total: number }>();
function score(field: string, ok: boolean, misses: string[], detail: string) {
  const s = scores.get(field) ?? { ok: 0, total: 0 };
  s.total++;
  if (ok) s.ok++;
  else misses.push(detail);
  scores.set(field, s);
}

function legField(key: string, want: string | number, got: NonNullable<ExtractedItem["leg"]>): boolean {
  switch (key) {
    case "number":
      return compact(got.number) === compact(want);
    case "departDate":
      return (got.departAt ?? "").slice(0, 10) === want;
    case "bookingRef":
      return compact(got.bookingRef) === compact(want);
    case "pricePerPersonCad":
      return near(got.pricePerPersonCad, Number(want), 0.1);
    default:
      return String((got as Record<string, unknown>)[key] ?? "").toUpperCase() === String(want).toUpperCase();
  }
}

function stayField(key: string, want: string | number, got: NonNullable<ExtractedItem["stay"]>): boolean {
  if (key === "hotelName") return similar(got.hotelName, want);
  if (key === "perNightCad") return near(got.perNightCad, Number(want), 0.15);
  return String((got as Record<string, unknown>)[key] ?? "").toUpperCase() === String(want).toUpperCase();
}

function matches(want: ExpectedItem, got: ExtractedItem): boolean {
  if (want.kind !== got.kind) return false;
  if (want.kind === "leg" && got.leg) {
    if (want.leg?.number) return compact(got.leg.number) === compact(want.leg.number);
    return !want.leg?.departDate || (got.leg.departAt ?? "").startsWith(String(want.leg.departDate));
  }
  if (want.kind === "stay" && got.stay) return similar(got.stay.hotelName, want.stay?.hotelName);
  if (want.kind === "activity" && got.activity) return similar(got.activity.title, want.title);
  return false;
}

// --- run -----------------------------------------------------------------------

const model = process.env.INBOX_MODEL?.trim() || "claude-opus-5-5";
const reader = createClaudeReader({ apiKey, model });
const lookup = createClaudeLookup({ apiKey, model });
console.log(`Inbox eval: ${selected.length} message${selected.length === 1 ? "" : "s"}, model ${model}, lookup ${withLookup ? "on" : "off"}.\n`);

for (const f of selected) {
  const misses: string[] = [];
  const text = f.message.text;
  const previews = (await previewLinks(findLinks(text), { fetchPreviews: false })).map((p) => {
    const given = f.links?.find((l) => l.url === p.url);
    return given ? { ...p, title: given.title ?? null, author: given.author ?? null } : p;
  });
  let found: ExtractedItem[];
  try {
    found = (await reader.read({ from: f.message.from, subject: f.message.subject, text, links: previews, pdfs: [] }, ctx)).items;
  } catch (e) {
    console.log(`✗ ${f.id}: the reader failed (${e instanceof Error ? e.message : e})`);
    score("items.found", false, misses, "reader failed");
    continue;
  }

  const used = new Set<number>();
  const pairs: { want: ExpectedItem; got: ExtractedItem | null }[] = f.expected.map((want) => {
    const i = found.findIndex((got, idx) => !used.has(idx) && matches(want, got));
    if (i >= 0) used.add(i);
    return { want, got: i >= 0 ? found[i]! : null };
  });
  for (const p of pairs) score("items.found", p.got != null, misses, `missing ${p.want.kind} ${p.want.title ?? p.want.stay?.hotelName ?? p.want.leg?.number ?? ""}`.trim());
  const extra = found.filter((_, i) => !used.has(i));
  scores.set("items.no-extras", {
    ok: (scores.get("items.no-extras")?.ok ?? 0) + (extra.length ? 0 : 1),
    total: (scores.get("items.no-extras")?.total ?? 0) + 1,
  });
  if (extra.length) misses.push(`extra: ${extra.map((e) => e.summary).join("; ")}`);

  let lookupsLeft = withLookup ? MAX_LOOKUPS_PER_MESSAGE : 0;
  for (const { want, got } of pairs) {
    if (!got) continue;
    if (want.kind === "leg" && got.leg) {
      for (const [key, value] of Object.entries(want.leg ?? {})) {
        score(`leg.${key}`, legField(key, value, got.leg), misses, `leg.${key}: wanted ${value}, got ${String((got.leg as Record<string, unknown>)[key === "departDate" ? "departAt" : key] ?? "null")}`);
      }
    }
    if (want.kind === "stay" && got.stay) {
      for (const [key, value] of Object.entries(want.stay ?? {})) {
        score(`stay.${key}`, stayField(key, value, got.stay), misses, `stay.${key}: wanted ${value}, got ${String((got.stay as Record<string, unknown>)[key] ?? "null")}`);
      }
    }
    if (want.kind === "activity" && got.activity) {
      score("activity.title", similar(got.activity.title, want.title), misses, `title: wanted ${want.title}, got ${got.activity.title}`);
      if (want.cityCode) score("activity.cityCode", got.activity.cityCode?.toUpperCase() === want.cityCode, misses, `city: wanted ${want.cityCode}, got ${got.activity.cityCode}`);
    }

    if (!want.lookup || lookupsLeft <= 0 || (got.kind !== "activity" && got.kind !== "stay")) continue;
    lookupsLeft--;
    const a = got.activity;
    const s = got.stay;
    const url = a?.url ?? s?.url ?? null;
    const cityCode = (a?.cityCode ?? s?.cityCode ?? want.cityCode ?? "").toUpperCase();
    const preview = previews.find((p) => p.url === url);
    try {
      const raw = await lookup.lookup({
        kind: got.kind,
        title: a?.title ?? s?.hotelName ?? "",
        city: byCode.get(cityCode) ?? null,
        routeCities,
        link: url ? { url, kind: classifyLink(url), title: preview?.title ?? null, author: preview?.author ?? null } : null,
        note: a?.note ?? null,
        message: [f.message.subject, text].filter(Boolean).join("\n"),
      });
      const l = want.lookup;
      if (!raw) {
        score("lookup.found", false, misses, "lookup found nothing");
        continue;
      }
      const checked = checkLookup(raw, { messageUrls: previews.map((p) => p.url), knownCities: known });
      score("lookup.found", checked.placeName != null, misses, "lookup named no place");
      if (l.placeName) score("lookup.placeName", similar(checked.placeName, l.placeName), misses, `place: wanted ${l.placeName}, got ${checked.placeName}`);
      if (l.websiteHost) score("lookup.website", hostIs(checked.website, l.websiteHost), misses, `website: wanted ${l.websiteHost}, got ${checked.website}`);
      if (l.ticketHost) score("lookup.ticketUrl", hostIs(checked.ticketUrl ?? (url && hostIs(url, l.ticketHost) ? url : null), l.ticketHost), misses, `tickets: wanted ${l.ticketHost}, got ${checked.ticketUrl}`);
      if (l.reserveHost) score("lookup.reserveUrl", hostIs(checked.reserveUrl ?? (url && hostIs(url, l.reserveHost) ? url : null), l.reserveHost), misses, `reserve: wanted ${l.reserveHost}, got ${checked.reserveUrl}`);
      if (l.eventDate) score("lookup.eventDate", checked.eventDate === l.eventDate, misses, `event date: wanted ${l.eventDate}, got ${checked.eventDate}`);
      if (l.minConfidence) score("lookup.confidence", RANK[checked.confidence] >= RANK[l.minConfidence], misses, `confidence: wanted ≥ ${l.minConfidence}, got ${checked.confidence}`);
      if (l.forbiddenHost) {
        const kept = [checked.website, checked.ticketUrl, checked.reserveUrl];
        score("lookup.no-injected-link", !kept.some((k) => hostIs(k, l.forbiddenHost!)), misses, `kept a link to ${l.forbiddenHost}`);
      }
      score("lookup.dropped-none", checked.dropped.length === 0, misses, `dropped unbacked links: ${checked.dropped.join(", ")}`);
    } catch (e) {
      score("lookup.found", false, misses, `lookup failed (${e instanceof Error ? e.message : e})`);
    }
  }

  console.log(`${misses.length ? "✗" : "✓"} ${f.id} [${f.category}]: ${found.length} found${misses.length ? `\n    ${misses.join("\n    ")}` : ""}`);
}

console.log("\nField scores:");
const width = Math.max(...[...scores.keys()].map((k) => k.length));
for (const [field, s] of [...scores.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${field.padEnd(width)}  ${String(s.ok).padStart(3)}/${String(s.total).padEnd(3)} ${((100 * s.ok) / s.total).toFixed(0).padStart(4)}%`);
}
