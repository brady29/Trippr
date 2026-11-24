import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { E2E_API_URL, E2E_BUNDLES, E2E_OWNER_INVITE } from "../playwright.config";

/**
 * Semantic search on the Activities page. The webServer made fake place vectors for the golden bundle and loaded
 * them with the real load job; the API answers questions with the fake query embedder (SEARCH_EMBEDDER=fake).
 * The vectors say nothing about meaning, so these tests check the plumbing and the page, not search quality: a
 * place's own name finds it first, filters narrow, and the notice shows when the answer is words only.
 */
const places = gunzipSync(readFileSync(`${E2E_BUNDLES}/2026-11-18/places.jsonl.gz`))
  .toString("utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { name: string; name_en: string | null; city_code: string; category: string });
const title = (p: { name: string; name_en: string | null }) => p.name_en ?? p.name;
// A name that is plain letters and unique in its city, so the search for it has one right answer.
const target =
  places.find((p) => p.city_code === "TYO" && /^[A-Za-z][A-Za-z ]{8,30}$/.test(title(p)) && places.filter((q) => title(q) === title(p)).length === 1) ??
  places.find((p) => p.city_code === "TYO")!;

test.describe.configure({ mode: "serial" });

test.describe("Activities: search by meaning", () => {
  test.beforeEach(async ({ page, request }) => {
    const login = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Owner" } });
    const token = (await login.json()).token as string;
    await request.post(`${E2E_API_URL}/invites/${E2E_OWNER_INVITE}/accept`, { headers: { authorization: `Bearer ${token}` } });
    await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
    await page.goto("/trips/asia-2027/library");
  });

  test("finds a place by its name, shows why it matched and where it came from", async ({ page }) => {
    const box = page.getByRole("textbox", { name: "Search by meaning" });
    await box.fill(title(target));
    await page.getByTestId("semantic-search-submit").click();
    const first = page.getByTestId("search-results").getByTestId("activity-item").first();
    await expect(first).toContainText(title(target));
    await expect(first.getByTestId("search-reason")).toHaveAttribute("data-match", /name|both/);
    await expect(first.getByTestId("search-reason")).toContainText(/name matches/i);
    await expect(first.getByTestId("catalogue-badge")).toBeVisible();
    await expect(first.getByTestId("catalogue-info")).toContainText("Source:");
    await expect(page.getByTestId("search-count")).toContainText("by meaning and name");
    await expect(page.getByTestId("search-notice")).toHaveCount(0);
  });

  test("narrows with the page's city filter", async ({ page }) => {
    await page.getByRole("combobox", { name: "Filter by city" }).selectOption("OSA");
    await page.getByRole("textbox", { name: "Search by meaning" }).fill("temple garden castle");
    await page.getByTestId("semantic-search-submit").click();
    await expect(page.getByTestId("search-results").getByTestId("activity-item").first()).toBeVisible();
    const chips = await page.getByTestId("search-results").getByTestId("activity-item").evaluateAll((items) => items.map((i) => i.textContent ?? ""));
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((t) => t.includes("OSA"))).toBe(true);
  });

  test("says so when the answer is words only", async ({ page }) => {
    // The API here has a query embedder; make the response look like one without, to see the page's wording.
    await page.route("**/trips/*/search?*", async (route) => {
      const real = await route.fetch();
      const body = await real.json();
      await route.fulfill({
        response: real,
        json: { ...body, mode: "lexical", engine: null, notice: { code: "no_embedder", message: "Meaning-based search is not set up on this server." } },
      });
    });
    await page.getByRole("textbox", { name: "Search by meaning" }).fill(title(target));
    await page.getByTestId("semantic-search-submit").click();
    await expect(page.getByTestId("search-notice")).toContainText("Matching words only");
    await expect(page.getByTestId("search-notice")).toContainText("not set up");
    await expect(page.getByTestId("search-count")).toContainText("by words");
    await expect(page.getByTestId("search-results").getByTestId("activity-item").first()).toBeVisible();
  });

  test("a failed search shows an error and leaves the page usable", async ({ page }) => {
    await page.route("**/trips/*/search?*", (route) =>
      route.fulfill({ status: 429, json: { error: { code: "rate_limited", message: "You are searching quickly. Try again in 20 seconds." } } }),
    );
    await page.getByRole("textbox", { name: "Search by meaning" }).fill("ramen");
    await page.getByTestId("semantic-search-submit").click();
    await expect(page.getByTestId("semantic-search")).toContainText("searching quickly");
    await expect(page.getByTestId("activity-list")).toBeVisible();
  });

  test("clearing the search removes the results", async ({ page }) => {
    await page.getByRole("textbox", { name: "Search by meaning" }).fill(title(target));
    await page.getByTestId("semantic-search-submit").click();
    await expect(page.getByTestId("search-results")).toBeVisible();
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByTestId("search-results")).toHaveCount(0);
  });
});
