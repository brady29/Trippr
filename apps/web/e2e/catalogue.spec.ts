import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
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
