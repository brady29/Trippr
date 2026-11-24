import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { E2E_API_URL, E2E_BUNDLES, E2E_OWNER_INVITE } from "../playwright.config";

/**
 * The catalogue: the webServer loads the pipeline's golden bundle (real Overture and Foursquare fixture rows for
 * Tokyo and Osaka) into the throwaway graph before the API starts, with the real load job.
 */
const bundle = readFileSync(`${E2E_BUNDLES}/2026-11-18/places.jsonl.gz`);
const places = gunzipSync(bundle)
  .toString("utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { name: string; name_en: string | null; city_code: string; category: string; rank: number });
const tokyo = places.filter((p) => p.city_code === "TYO");
const title = (p: { name: string; name_en: string | null }) => p.name_en ?? p.name;

/** The bundle's LLM enrichment (written by the pipeline's own writer from a fake answer cache; no model was called). */
interface Enriched {
  id: string;
  summary: string;
  duration_min: number | null;
  best_time: string | null;
  indoor: boolean | null;
  price_level: string | null;
  display_name: string | null;
  is_generic_name: boolean;
  ai_label: string | null;
}
const enriched = gunzipSync(readFileSync(`${E2E_BUNDLES}/2026-11-18/enrichment.jsonl.gz`))
  .toString("utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Enriched);
const placeById = new Map(
  gunzipSync(bundle)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; name: string; name_en: string | null })
    .map((p) => [p.id, p] as const),
);
const titleOf = (e: Enriched) => title(placeById.get(e.id)!);

test.describe.configure({ mode: "serial" });

test.describe("Data page", () => {
  test("is public and shows sources, licences, counts and the quality checks", async ({ page }) => {
    await page.goto("/data");
    await expect(page.getByRole("heading", { name: "Data", level: 1 })).toBeVisible();
    const overture = page.locator('[data-testid="source-card"][data-source="overture"]');
    await expect(overture).toContainText("Overture Maps Places");
    await expect(overture).toContainText("CDLA-Permissive-2.0");
    await expect(overture.getByTestId("source-attribution")).toContainText("Overture Maps Foundation");
    await expect(overture.getByTestId("source-activities")).toContainText(/[1-9]\d* activities/);
    const foursquare = page.locator('[data-testid="source-card"][data-source="foursquare"]');
    await expect(foursquare).toContainText("Apache-2.0");
    await expect(page.getByTestId("checks-status")).toHaveText("All checks passed");
    await expect(page.getByTestId("checks-list")).toContainText("provenance.licence");
    await expect(page.getByTestId("latest-load")).toContainText("2026-11-18");
    await expect(page.getByTestId("pipeline")).toContainText("Curate");
    await expect(page.getByTestId("licence-notes")).toContainText("licence");
  });

  test("shows what the AI enrichment covered, which model did it, and how it scored", async ({ page }) => {
    await page.goto("/data");
    await expect(page.getByTestId("enrichment-stats")).toBeVisible();
    await expect(page.getByTestId("enrichment-places")).toContainText(`${enriched.length} of ${places.length} places`);
    await expect(page.getByTestId("enrichment-summaries")).toHaveText(String(enriched.filter((e) => e.summary).length));
    await expect(page.getByTestId("enrichment-model")).toContainText("claude-haiku-5-5");
    await expect(page.getByTestId("enrichment-date")).toHaveText("2026-11-18");
    await expect(page.getByTestId("enrichment-eval")).toContainText("Scores on the labelled places");
    await expect(page.getByTestId("eval-tag_f1")).toContainText("80.0%");
    await expect(page.getByTestId("pipeline")).not.toContainText("AI summaries (not built yet)");
  });

  test("is linked from the home screen and the trip navigation", async ({ page, request }) => {
    const login = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Owner" } });
    const token = (await login.json()).token as string;
    await request.post(`${E2E_API_URL}/invites/${E2E_OWNER_INVITE}/accept`, { headers: { authorization: `Bearer ${token}` } });
    await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
    await page.goto("/trips/asia-2027");
    await page.getByRole("link", { name: "Data", exact: true }).click();
    await expect(page).toHaveURL(/\/data$/);
    await expect(page.getByTestId("source-card").first()).toBeVisible();
  });
});

test.describe("Activities: catalogue filters and paging", () => {
  test.beforeEach(async ({ page, request }) => {
    const login = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Owner" } });
    const token = (await login.json()).token as string;
    await request.post(`${E2E_API_URL}/invites/${E2E_OWNER_INVITE}/accept`, { headers: { authorization: `Bearer ${token}` } });
    await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
  });

  test("shows the group's own ideas and the catalogue, and narrows by scope", async ({ page }) => {
    await page.goto("/trips/asia-2027/library");
    await expect(page.getByTestId("result-count")).toContainText(/\d+ of \d+ shown/);
    await page.getByRole("combobox", { name: "Show" }).selectOption("catalogue");
    await expect(page.getByTestId("catalogue-badge").first()).toBeVisible();
    await expect(page.getByTestId("activity-item").first()).toContainText("Source:");
    await page.getByRole("combobox", { name: "Show" }).selectOption("mine");
    await expect(page.getByTestId("catalogue-badge")).toHaveCount(0);
    await expect(page.getByTestId("activity-item").first()).toBeVisible();
  });

  test("searches by name, and filters by city, category and source", async ({ page }) => {
    await page.goto("/trips/asia-2027/library");
    await page.getByRole("combobox", { name: "Show" }).selectOption("catalogue");
    const target = tokyo.find((p) => /[A-Za-z]{4}/.test(title(p))) ?? tokyo[0]!;
    await page.getByRole("searchbox", { name: "Search activities" }).fill(title(target));
    await expect(page.getByTestId("activity-item").filter({ hasText: title(target) }).first()).toBeVisible();
    await page.getByRole("searchbox", { name: "Search activities" }).fill("");

    await page.getByRole("combobox", { name: "Filter by city" }).selectOption("OSA");
    await expect.poll(async () => (await page.getByTestId("activity-item").count()) > 0).toBe(true);
    const osakaCodes = await page.getByTestId("activity-item").evaluateAll((items) => items.map((i) => i.textContent ?? ""));
    expect(osakaCodes.every((t) => t.includes("OSA"))).toBe(true);

    const category = places.find((p) => p.city_code === "OSA")!.category;
    await page.getByRole("combobox", { name: "Filter by category" }).selectOption(category);
    await expect(page.getByTestId("catalogue-info").first()).toContainText(category.replace(/_/g, " "));
    await page.getByRole("combobox", { name: "Filter by source" }).selectOption({ label: "Overture Maps Places" });
    await expect(page.getByTestId("result-count")).toContainText(/\d+ of \d+ shown/);
    await page.getByRole("combobox", { name: "Filter by rank" }).selectOption("10");
    await expect(page.getByTestId("catalogue-info").first()).toContainText(/#\d+ in Osaka/);
  });

  test("pages 50 at a time", async ({ page }) => {
    await page.goto("/trips/asia-2027/library");
    await page.getByRole("combobox", { name: "Filter by city" }).selectOption("TYO");
    const count = page.getByTestId("result-count");
    await expect(count).toContainText(/^50 of \d+ shown$/);
    await expect(page.getByTestId("activity-item")).toHaveCount(50);
    await page.getByTestId("show-more").click();
    await expect(page.getByTestId("show-more")).toHaveCount(0);
    const total = Number(/of (\d+) shown/.exec((await count.textContent()) ?? "")?.[1]);
    expect(total).toBeGreaterThan(50);
    await expect(page.getByTestId("activity-item")).toHaveCount(total);
  });

  test("a vote on a catalogue place puts it in the group's own list", async ({ page }) => {
    await page.goto("/trips/asia-2027/library");
    await page.getByRole("combobox", { name: "Show" }).selectOption("catalogue");
    await page.getByRole("combobox", { name: "Filter by city" }).selectOption("OSA");
    const item = page.getByTestId("activity-item").first();
    const name = (await item.locator("div.font-medium").first().textContent())!.trim();
    await item.getByRole("button", { name: /Upvote|Vote up|Thumbs up/i }).first().click();
    await page.getByRole("combobox", { name: "Show" }).selectOption("mine");
    await page.getByRole("combobox", { name: "Filter by city" }).selectOption("OSA");
    await expect(page.getByTestId("activity-item").filter({ hasText: name })).toBeVisible();
  });
});

test.describe("Activities: AI summaries and enrichment filters", () => {
  test.beforeEach(async ({ page, request }) => {
    const login = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Owner" } });
    const token = (await login.json()).token as string;
    await request.post(`${E2E_API_URL}/invites/${E2E_OWNER_INVITE}/accept`, { headers: { authorization: `Bearer ${token}` } });
    await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
  });

  const items = (page: Page) => page.getByTestId("activity-item");
  const searchFor = async (page: Page, text: string) => {
    await page.getByRole("searchbox", { name: "Search activities" }).fill(text);
    await expect(page.getByTestId("result-count")).toContainText(/\d+ of \d+ shown/);
  };

  test("an AI-written summary always says it was written by AI, and names its sources", async ({ page }) => {
    await page.goto("/trips/asia-2027/library");
    await page.getByRole("combobox", { name: "Show" }).selectOption("catalogue");
    const withSummary = items(page).filter({ has: page.getByTestId("ai-summary") });
    await expect(withSummary.first()).toBeVisible();
    await expect(withSummary.first().getByTestId("ai-label")).toContainText("Summary written by AI");
    // No summary on the page is without its label.
    const cards = await items(page).evaluateAll((els) =>
      els.map((el) => ({ summary: Boolean(el.querySelector('[data-testid="ai-summary"]')), label: Boolean(el.querySelector('[data-testid="ai-label"]')) })),
    );
    expect(cards.some((c) => c.summary)).toBe(true);
    expect(cards.filter((c) => c.summary).every((c) => c.label)).toBe(true);

    // The sentence is the pipeline's own, with the sources the model was given.
    await page.getByRole("combobox", { name: "Show" }).selectOption("all");
    const row = enriched.find((e) => e.summary && e.ai_label?.includes(" from ") && /[A-Za-z]{4}/.test(titleOf(e)))!;
    await searchFor(page, titleOf(row));
    const card = items(page).filter({ hasText: row.summary }).first();
    await expect(card.getByTestId("ai-summary")).toHaveText(row.summary);
    await expect(card.getByTestId("ai-label")).toHaveText(row.ai_label!);
  });

  test("shows duration, best time and indoor or outdoor as badges", async ({ page }) => {
    await page.goto("/trips/asia-2027/library");
    const row = enriched.find((e) => e.summary && e.duration_min != null && e.best_time && e.indoor != null && /[A-Za-z]{4}/.test(titleOf(e)))!;
    await searchFor(page, titleOf(row));
    const card = items(page).filter({ hasText: row.summary }).first();
    await expect(card.getByTestId("badge-duration")).toContainText(/\d+ (min|h)/);
    await expect(card.getByTestId("badge-best-time")).toContainText(row.best_time === "any" ? "Any time of day" : /Best: /);
    await expect(card.getByTestId("badge-indoor")).toHaveText(row.indoor ? "Indoor" : "Outdoor");
  });

  test("shows a suggested name under a generic title and never in place of it", async ({ page }) => {
    await page.goto("/trips/asia-2027/library");
    const row = enriched.find((e) => e.is_generic_name && e.display_name && /[A-Za-z]{4}/.test(titleOf(e)))!;
    await searchFor(page, titleOf(row));
    const card = items(page).filter({ has: page.getByTestId("generic-subtitle") }).filter({ hasText: titleOf(row) }).first();
    await expect(card.getByTestId("generic-subtitle")).toHaveText(row.display_name!);
    await expect(card.locator("div.font-medium").first()).toHaveText(titleOf(row));
  });

  test("filters by best time, indoor or outdoor, time needed and price, alone and together", async ({ page }) => {
    await page.goto("/trips/asia-2027/library");
    const count = page.getByTestId("result-count");
    const expectCount = async (n: number) => {
      expect(n).toBeGreaterThan(0);
      await expect(count).toHaveText(`${n} of ${n} shown`);
    };
    const bestIn = (...times: string[]) => (e: Enriched) => times.includes(e.best_time ?? "");

    await page.getByRole("combobox", { name: "Filter by best time" }).selectOption("evening");
    await expectCount(enriched.filter(bestIn("evening", "any")).length);
    const times = await items(page).getByTestId("badge-best-time").allTextContents();
    expect(times.length).toBeGreaterThan(0);
    expect(times.every((t) => /evening|Any time/.test(t))).toBe(true);

    await page.getByRole("combobox", { name: "Filter by indoor or outdoor" }).selectOption("indoor");
    await expectCount(enriched.filter((e) => bestIn("evening", "any")(e) && e.indoor === true).length);
    await page.getByRole("combobox", { name: "Filter by best time" }).selectOption("");
    await expectCount(enriched.filter((e) => e.indoor === true).length);
    await page.getByRole("combobox", { name: "Filter by indoor or outdoor" }).selectOption("outdoor");
    await expectCount(enriched.filter((e) => e.indoor === false).length);
    for (const t of await items(page).getByTestId("badge-indoor").allTextContents()) expect(t).toBe("Outdoor");

    await page.getByRole("combobox", { name: "Filter by indoor or outdoor" }).selectOption("");
    await page.getByRole("combobox", { name: "Filter by time needed" }).selectOption("60");
    await expectCount(enriched.filter((e) => e.duration_min != null && e.duration_min <= 60).length);
    await page.getByRole("combobox", { name: "Filter by time needed" }).selectOption("");

    const price = enriched.find((e) => e.price_level === "$$")!.price_level!;
    await page.getByRole("combobox", { name: "Filter by price" }).selectOption(price);
    await expectCount(enriched.filter((e) => e.price_level === price).length);
    await page.getByRole("combobox", { name: "Filter by price" }).selectOption("");
    await expect(count).toContainText(/\d+ of \d+ shown/);
  });
});
