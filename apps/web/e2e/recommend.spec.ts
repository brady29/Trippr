import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_API_URL, E2E_BUNDLES, E2E_OWNER_INVITE } from "../playwright.config";

/**
 * "Suggested for this stop" in the Tokyo stop's drawer, on the pipeline's golden bundle with the fake place vectors the
 * webServer loaded (SEARCH_EMBEDDER=fake). The fake vectors are made from names, categories and descriptions, so places of
 * the same category sit close together: that is enough to see the whole path (votes -> suggestions -> reasons -> actions),
 * not to judge recommendation quality (pnpm eval:recommend does that). The loading, error, empty and cold-start states are
 * checked by answering the request with what the API sends in those cases.
 */
type Place = { id: string; name: string; name_en: string | null; city_code: string; category: string };
const places = gunzipSync(readFileSync(`${E2E_BUNDLES}/2026-11-18/places.jsonl.gz`))
  .toString("utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Place);
const title = (p: Place) => p.name_en ?? p.name;
// A temple in Tokyo with an English name: the other temples there are the ones the fake vectors put closest to it.
const liked = places.find((p) => p.city_code === "TYO" && p.category === "temple_shrine" && p.name_en && /^[A-Za-z -]+$/.test(p.name_en))!;

test.describe.configure({ mode: "serial" });

let token = "";

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Owner" } });
  token = (await login.json()).token;
  const accept = await request.post(`${E2E_API_URL}/invites/${E2E_OWNER_INVITE}/accept`, { headers: { authorization: `Bearer ${token}` } });
  expect([200, 404]).toContain(accept.status());
  const vote = await request.put(`${E2E_API_URL}/activities/${liked.id}/vote`, { headers: { authorization: `Bearer ${token}` }, data: { value: 1 } });
  expect(vote.status()).toBe(200);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
});

/** The card whose own title (not a reason that names it) is `name`. */
const cardTitled = (page: Page, scope: Locator, name: string) =>
  scope.getByTestId("activity-item").filter({ has: page.locator("div.font-medium", { hasText: name }) });

async function openTokyo(page: Page) {
  await page.goto("/routes/route-main");
  const stop = page.locator('[data-testid="stop-card"][data-city="TYO"]');
  await stop.getByRole("button", { name: /^Activities \(\d+ in Tokyo\)$/ }).click();
  const drawer = page.getByRole("dialog", { name: "Activities in Tokyo" });
  await expect(drawer.getByTestId("suggestions")).toBeVisible();
  return drawer;
}

test("suggests places like the ones the group voted for, each with its reason, source and licence", async ({ page }) => {
  const drawer = await openTokyo(page);
  const panel = drawer.getByTestId("suggestions");
  await expect(panel.getByRole("heading", { name: "Suggested for this stop" })).toBeVisible();
  const cards = panel.getByTestId("suggestions-list").getByTestId("activity-item");
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeLessThanOrEqual(6);
  // The first card is the nearest in meaning to the temple the group voted for, and says so.
  await expect(cards.first().getByTestId("suggestion-reason")).toContainText(`Similar to ${title(liked)}, which you voted for`);
  await expect(cards.first().getByTestId("suggestion-reason")).toHaveAttribute("data-because", "similar");
  // Every card has a reason, a source with its licence, and the AI label wherever it shows a summary; none shows a percentage.
  const texts = await cards.evaluateAll((els) =>
    els.map((el) => ({
      reason: el.querySelector('[data-testid="suggestion-reason"]')?.textContent ?? "",
      info: el.querySelector('[data-testid="catalogue-info"]')?.textContent ?? "",
      summary: Boolean(el.querySelector('[data-testid="ai-summary"]')),
      label: Boolean(el.querySelector('[data-testid="ai-label"]')),
      text: el.textContent ?? "",
    })),
  );
  expect(texts.length).toBeGreaterThan(0);
  for (const t of texts) {
    expect(t.reason.length).toBeGreaterThan(5);
    expect(t.reason).not.toMatch(/%|similarity|score/i);
    expect(t.info).toContain("Source:");
    if (t.summary) expect(t.label).toBe(true);
    expect(t.text).not.toContain(`${liked.id}`);
  }
  // The place the group voted for is in the drawer's own list, not in the suggestions.
  const titles = await cards.evaluateAll((els) => els.map((el) => el.querySelector("div.font-medium")?.textContent?.trim() ?? ""));
  expect(titles).not.toContain(title(liked));
  await expect(cardTitled(page, drawer, title(liked)).first()).toBeVisible();
});

test("Add to ideas votes the place up: it joins the city's list and leaves the suggestions", async ({ page }) => {
  const drawer = await openTokyo(page);
  const cards = drawer.getByTestId("suggestions-list").getByTestId("activity-item");
  await expect(cards.first()).toBeVisible();
  const name = (await cards.first().locator("div.font-medium").first().textContent())!.trim();
  await cards.first().getByRole("button", { name: `Add ${name} to ideas` }).click();
  await expect(cardTitled(page, drawer.getByTestId("suggestions-list"), name)).toHaveCount(0);
  // Now it is one of the group's ideas, with the vote.
  const mine = cardTitled(page, drawer, name);
  await expect(mine).toHaveCount(1);
  await expect(mine.getByTestId("votes")).toHaveText("1");
});

test("Plan here plans the place at this stop and removes it from the suggestions", async ({ page }) => {
  const drawer = await openTokyo(page);
  const cards = drawer.getByTestId("suggestions-list").getByTestId("activity-item");
  await expect(cards.first()).toBeVisible();
  const name = (await cards.first().locator("div.font-medium").first().textContent())!.trim();
  await cards.first().getByRole("button", { name: `Plan ${name} at this stop` }).click();
  const box = drawer.getByRole("checkbox", { name: `Plan ${name} for this stop` });
  await expect(box).toBeChecked();
  await expect(cardTitled(page, drawer.getByTestId("suggestions-list"), name)).toHaveCount(0);
  await expect(page.locator('[data-testid="stop-card"][data-city="TYO"]')).toContainText(name);
  // Leave the plan as it was.
  await box.click();
  // Nobody voted or commented on it, so once it is unplanned it is an ordinary catalogue place again: not in the list.
  await expect(box).toHaveCount(0);
});

test("the time-of-day and indoor filters narrow the suggestions to places the enrichment knows", async ({ page }) => {
  const drawer = await openTokyo(page);
  const panel = drawer.getByTestId("suggestions");
  const asked = page.waitForRequest((r) => r.url().includes("/suggestions") && r.url().includes("indoor=false"));
  await panel.getByRole("combobox", { name: "Suggestions: indoor or outdoor" }).selectOption("outdoor");
  await asked;
  await expect(panel.getByTestId("suggestions-list").getByTestId("activity-item").first().or(panel.getByTestId("suggestions-empty")).or(panel.getByTestId("suggestions-notice"))).toBeVisible();
  for (const badge of await panel.getByTestId("badge-indoor").all()) await expect(badge).toHaveText("Outdoor");
  // Clearing the filter brings the full list back.
  await panel.getByRole("combobox", { name: "Suggestions: indoor or outdoor" }).selectOption("");
  await expect(panel.getByTestId("suggestions-list").getByTestId("activity-item").first()).toBeVisible();
});

test.describe("states", () => {
  const respond = (page: Page, body: unknown, status = 200) =>
    page.route("**/stops/*/suggestions*", (route) => route.fulfill({ status, json: body }));
  const base = { stopId: "s", cityCode: "TYO", cityName: "Tokyo", basis: "catalogue_rank", signals: { liked: 0, disliked: 0, members: 0 }, likedTags: [], suggestions: [] };

  test("cold start says so in plain words", async ({ page }) => {
    const message = "Nobody has voted on, planned or commented on places in Tokyo yet, so these are the city's top-ranked places. Vote on a few and they will follow your taste.";
    await respond(page, { ...base, notice: { code: "cold_start", message } });
    const drawer = await openTokyo(page);
    await expect(drawer.getByTestId("suggestions-notice")).toHaveAttribute("data-code", "cold_start");
    await expect(drawer.getByTestId("suggestions-notice")).toContainText("Nobody has voted");
  });

  test("nothing left shows the notice and the rest of the drawer still works", async ({ page }) => {
    await respond(page, { ...base, notice: { code: "none_left", message: "Nothing left to suggest in Tokyo: every catalogue place there is planned, voted on or filtered out." } });
    const drawer = await openTokyo(page);
    await expect(drawer.getByTestId("suggestions-notice")).toContainText("Nothing left to suggest");
    await expect(drawer.getByTestId("activity-item").first()).toBeVisible();
  });

  test("no suggestions and no notice reads as empty", async ({ page }) => {
    await respond(page, { ...base, basis: "group_taste", notice: null });
    const drawer = await openTokyo(page);
    await expect(drawer.getByTestId("suggestions-empty")).toContainText("Nothing to suggest in Tokyo yet");
  });

  test("a failed request shows an error with Try again, and the drawer's own list is still there", async ({ page }) => {
    let calls = 0;
    await page.route("**/stops/*/suggestions*", (route) => {
      calls++;
      return route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong" } } });
    });
    const drawer = await openTokyo(page);
    await expect(drawer.getByTestId("suggestions-error")).toContainText("Something went wrong");
    await expect(drawer.getByTestId("activity-item").first()).toBeVisible();
    const before = calls;
    await drawer.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => calls).toBeGreaterThan(before);
  });

  test("while it loads the panel says so", async ({ page }) => {
    await page.route("**/stops/*/suggestions*", async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.fulfill({ status: 200, json: { ...base, notice: null } });
    });
    await page.goto("/routes/route-main");
    await page.locator('[data-testid="stop-card"][data-city="TYO"]').getByRole("button", { name: /^Activities \(\d+ in Tokyo\)$/ }).click();
    await expect(page.getByRole("dialog", { name: "Activities in Tokyo" }).getByText("Finding suggestions")).toBeVisible();
  });
});
