import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { E2E_API_URL, E2E_BUNDLES, E2E_OWNER_INVITE } from "../playwright.config";

/**
 * Stay analytics on the pipeline's golden bundle, which the webServer loads with the real load job: Inside Airbnb
 * aggregates for Tokyo and Singapore (fixture data), open-data hotels in Tokyo's seeded areas, and place-based scores for
 * a few more. Beijing has no Inside Airbnb data, so its areas show the honest empty state.
 */
const lines = (name: string) =>
  gunzipSync(readFileSync(`${E2E_BUNDLES}/2026-11-18/${name}`))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const hotels = lines("hotels.jsonl.gz") as { name: string; name_en: string | null; area_id: string }[];
const asakusaHotels = hotels.filter((h) => h.area_id === "area-tyo-asakusa");
const hotelTitle = (h: { name: string; name_en: string | null }) => h.name_en ?? h.name;

test.describe.configure({ mode: "serial" });

let token = "";

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Owner" } });
  token = (await login.json()).token;
  const accept = await request.post(`${E2E_API_URL}/invites/${E2E_OWNER_INVITE}/accept`, { headers: { authorization: `Bearer ${token}` } });
  expect([200, 404]).toContain(accept.status());
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
});

async function openStay(page: Page, city: string) {
  await page.goto("/routes/route-main");
  const stop = page.locator(`[data-testid="stop-card"][data-city="${city}"]`);
  await stop.getByRole("button", { name: "Where to stay" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe("Area cards", () => {
  test("show the stay score with its parts, the price range and the sentence that explains it", async ({ page }) => {
    const drawer = await openStay(page, "TYO");
    const block = drawer.locator('[data-testid="stay-block"][data-area="area-tyo-shibuya"]');
    const card = block.getByTestId("stay-card");
    await expect(card).toHaveAttribute("data-state", "market");
    await expect(card.getByTestId("stay-score")).toHaveText(/^\d{1,3}$/);
    await expect(card.getByTestId("stay-part")).toHaveCount(5);
    for (const part of ["value", "centrality", "walkability", "quiet", "reviews"]) await expect(card.locator(`[data-part="${part}"]`)).toBeVisible();
    await expect(card.getByTestId("stay-price")).toContainText(/CAD \d+ to CAD \d+ a night/);
    await expect(card.getByTestId("stay-price")).toContainText("Tokyo median");
    await expect(card.getByTestId("stay-explanation")).toContainText("Cheaper than");
    await expect(card.getByTestId("stay-explanation")).toContainText("km from the city centre");
    await expect(card.getByTestId("stay-market")).toContainText("listings");
  });

  test("say where the numbers come from: snapshot date, coverage and the CC BY 4.0 credit", async ({ page }) => {
    const drawer = await openStay(page, "TYO");
    const card = drawer.locator('[data-testid="stay-block"][data-area="area-tyo-shibuya"]').getByTestId("stay-card");
    await expect(card.getByTestId("stay-snapshot")).toHaveText("Snapshot 2026-09-25");
    await expect(card.getByTestId("stay-coverage")).toHaveText("Inside Airbnb covers 2 of 108 cities.");
    await expect(card.getByTestId("stay-attribution")).toContainText("Data from Inside Airbnb (insideairbnb.com), CC BY 4.0");
  });

  test("link to Airbnb and hotel searches for the area and the stop's dates, with nothing to track you", async ({ page }) => {
    const drawer = await openStay(page, "TYO");
    const block = drawer.locator('[data-testid="stay-block"][data-area="area-tyo-asakusa"]');
    const airbnb = block.locator('a[data-provider="airbnb"]');
    await expect(airbnb).toHaveText(/Search Airbnb/);
    const href = (await airbnb.getAttribute("href"))!;
    expect(href).toMatch(/^https:\/\/www\.airbnb\.com\/s\/Asakusa--Tokyo\/homes\?checkin=\d{4}-\d{2}-\d{2}&checkout=\d{4}-\d{2}-\d{2}&adults=\d+&currency=CAD$/);
    const hotels = block.locator('a[data-provider="booking"]');
    await expect(hotels).toHaveText(/Search hotels/);
    expect(decodeURIComponent((await hotels.getAttribute("href"))!)).toContain("ss=Asakusa, Tokyo");
    for (const a of [airbnb, hotels]) {
      await expect(a).toHaveAttribute("target", "_blank");
      await expect(a).toHaveAttribute("rel", /noopener/);
      expect((await a.getAttribute("href"))!).not.toMatch(/aid=|affiliate|utm_/);
    }
  });

  test("say so honestly when the city has no stay data", async ({ page }) => {
    const drawer = await openStay(page, "BJS");
    const block = drawer.locator('[data-testid="stay-block"][data-area="area-bjs-gulou"]');
    const card = block.getByTestId("stay-card");
    await expect(card).toHaveAttribute("data-state", "none");
    await expect(card.getByTestId("stay-empty-title")).toHaveText("No stay data for this city");
    await expect(card).toContainText("Inside Airbnb covers 2 of 108 cities");
    await expect(block.getByTestId("stay-score")).toHaveCount(0);
    await expect(block.getByTestId("stay-price")).toHaveCount(0);
    // The search links are still useful there.
    await expect(block.locator('a[data-provider="airbnb"]')).toHaveAttribute("href", /airbnb\.com\/s\/Dongcheng%20hutongs%20near%20Gulou--Beijing\/homes/);
  });

  test("list hotels from open data with their sources, and add one to the group's list", async ({ page }) => {
    const drawer = await openStay(page, "TYO");
    const block = drawer.locator('[data-testid="stay-block"][data-area="area-tyo-asakusa"]');
    await block.getByTestId("stay-suggestions-toggle").click();
    const rows = block.getByTestId("stay-suggestion");
    await expect(rows).toHaveCount(asakusaHotels.length);
    for (const h of asakusaHotels) await expect(block.getByTestId("stay-suggestions")).toContainText(hotelTitle(h));
    await expect(block.getByTestId("stay-suggestion-attribution")).toContainText(/OpenStreetMap|Overture|Foursquare/);
    await expect(block).toContainText("No prices here");

    const first = rows.first();
    const name = (await first.locator("div.font-medium").first().innerText()).trim();
    await first.getByRole("button", { name: /^Add / }).click();
    await expect(first.getByRole("button", { name: /^Add / })).toHaveText("Added");
    // It is now one of the group's hotels, in that area, with no price.
    await expect(drawer.getByTestId("hotel-item").filter({ hasText: name })).toBeVisible();
    // ...and the open-data list still has it (suggestions are never used up).
    await expect(rows).toHaveCount(asakusaHotels.length);
  });
});

test.describe("the Stay prices map layer", () => {
  test("is off until switched on, then shows a colour scale per city with the snapshot and the credit", async ({ page }) => {
    await page.goto("/trips/asia-2027/map?route=route-main");
    await expect(page.getByTestId("map-region")).toBeVisible();
    await expect(page.getByTestId("stay-legend")).toHaveCount(0);
    const cells = page.waitForResponse((r) => r.url().includes("/stay/cells") && r.ok());
    await page.getByTestId("stay-toggle").getByRole("checkbox").check();
    const body = (await (await cells).json()) as { cells: { id: string; city: string; price: number | null }[]; cities: { cityCode: string; scale: { low: number; high: number } | null }[]; attribution: string };
    expect(body.cells.length).toBeGreaterThan(0);
    expect(body.cities.map((c) => c.cityCode)).toContain("TYO");
    // Aggregates only: a cell has an id, a place, a price and a count, nothing else.
    expect(Object.keys(body.cells[0]!).sort()).toEqual(["city", "id", "lat", "listings", "lon", "pp", "price", "score"]);

    const legend = page.getByTestId("stay-legend");
    await expect(legend).toBeVisible();
    await expect(legend).toHaveAttribute("data-cells", /^[1-9]\d*$/);
    const tokyo = legend.locator('[data-testid="stay-legend-row"][data-city="TYO"]');
    await expect(tokyo).toContainText(/Tokyo: CAD \d+ to CAD \d+ a night/);
    await expect(tokyo).toContainText("snapshot 2026-09-25");
    await expect(legend).toContainText("cheaper");
    await expect(legend).toContainText("dearer");
    await expect(page.getByTestId("stay-legend-attribution")).toContainText("Inside Airbnb");
    await expect(page.getByTestId("stay-legend-attribution")).toContainText("CC BY 4.0");

    await page.getByTestId("stay-toggle").getByRole("checkbox").uncheck();
    await expect(page.getByTestId("stay-legend")).toHaveCount(0);
  });

  test("leaves the other layers where they were", async ({ page }) => {
    await page.goto("/trips/asia-2027/map?route=route-main");
    const layers = page.getByTestId("map-layers");
    await expect(layers.getByRole("checkbox", { name: /Areas/ })).toBeChecked();
    await layers.getByTestId("stay-toggle").getByRole("checkbox").check();
    await expect(layers.getByRole("checkbox", { name: /Areas/ })).toBeChecked();
    await expect(page.getByTestId("map-list")).toBeVisible();
  });
});

test.describe("the Data page", () => {
  test("shows Inside Airbnb coverage, snapshot dates, the attribution and the stay checks", async ({ page }) => {
    await page.goto("/data");
    const stay = page.getByTestId("data-stay");
    await expect(stay).toBeVisible();
    await expect(page.getByTestId("stay-coverage-note")).toContainText("Inside Airbnb covers 2 of 108 cities");
    await expect(stay.locator('[data-testid="stay-city"][data-city="TYO"]')).toContainText("2026-09-25");
    await expect(stay.locator('[data-testid="stay-city"][data-city="SIN"]')).toContainText("2026-09-23");
    await expect(page.getByTestId("stay-attribution")).toContainText("Data from Inside Airbnb (insideairbnb.com), CC BY 4.0");
    await expect(page.getByTestId("stay-attribution")).toContainText("CC-BY-4.0");
    await expect(page.getByTestId("stay-checks-status")).toHaveText("Stay checks passed");
    await page.getByText(/Stay check results/).click();
    await expect(page.getByTestId("stay-checks-list")).toContainText("stay.unit.unique_ids");
    await expect(page.getByTestId("stay-weights")).toContainText("Central 30%");
    await expect(page.getByTestId("stay-hotels")).toContainText(`${hotels.length} in the graph`);
    const airbnb = page.locator('[data-testid="source-card"][data-source="insideairbnb"]');
    await expect(airbnb).toContainText("CC-BY-4.0");
    await expect(page.locator('[data-testid="source-card"][data-source="osm_lodging"]').getByTestId("source-hotels")).toBeVisible();
  });
});
