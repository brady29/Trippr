import { expect, test, type Page } from "@playwright/test";
import { E2E_API_URL, E2E_OWNER_INVITE } from "../playwright.config";

test.describe.configure({ mode: "serial" });

let token = "";

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Owner" } });
  expect(login.ok()).toBeTruthy();
  token = (await login.json()).token;
  // Claim the seeded trip. A 404 means this user already claimed it on a reused server.
  const accept = await request.post(`${E2E_API_URL}/invites/${E2E_OWNER_INVITE}/accept`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect([200, 404]).toContain(accept.status());
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
});

const stopCities = (page: Page) =>
  page.getByTestId("stop-card").evaluateAll((cards) => cards.map((c) => (c as HTMLElement).dataset.city));

test("trip home lists both real routes", async ({ page }) => {
  await page.goto("/trips/asia-2027");
  const cards = page.getByTestId("route-card");
  await expect(cards.filter({ hasText: "Main" }).first()).toBeVisible();
  await expect(cards.filter({ hasText: "With Shanghai" })).toBeVisible();
  await expect(cards.filter({ hasText: "Main" }).first()).toContainText("40");
});

test("add a stop", async ({ page }) => {
  await page.goto("/routes/route-with-shanghai");
  await expect(page.getByTestId("stop-card")).toHaveCount(9);
  await page.getByRole("combobox", { name: "Search for a city to add" }).fill("Chengdu");
  await page.getByRole("option", { name: /Chengdu/ }).click();
  await page.getByRole("button", { name: "Add stop" }).click();
  await expect(page.locator('[data-testid="stop-card"][data-city="CTU"]')).toBeVisible();
  await expect(page.getByTestId("total-nights")).toHaveText("38");
});

test("reorder stops and see the dates move", async ({ page }) => {
  await page.goto("/routes/route-with-shanghai");
  await expect(page.locator('[data-testid="stop-card"][data-city="CTU"]')).toBeVisible();
  const before = await stopCities(page);
  const at = before.indexOf("CTU");
  await page.getByRole("button", { name: "Move Chengdu earlier" }).click();
  await expect.poll(() => stopCities(page)).toEqual([...before.slice(0, at - 1), "CTU", before[at - 1], ...before.slice(at + 1)]);
  // Survives a reload, so the server saved it.
  await page.reload();
  await expect.poll(async () => (await stopCities(page)).indexOf("CTU")).toBe(at - 1);
});

test("duplicate a route", async ({ page }) => {
  await page.goto("/trips/asia-2027");
  const main = page.getByTestId("route-card").filter({ has: page.getByRole("link", { name: "Main", exact: true }) });
  await main.getByRole("button", { name: "Duplicate" }).click();
  await expect(page.getByRole("link", { name: "Main copy" })).toBeVisible();
});

test("compare two routes", async ({ page }) => {
  await page.goto("/trips/asia-2027/compare?a=route-main&b=route-with-shanghai");
  await expect(page.getByTestId("compare-a")).toContainText("Chongqing");
  await expect(page.getByTestId("compare-b")).toContainText("Shanghai");
  await expect(page.getByTestId("compare-shared")).toContainText("Tokyo");
});

test("plan an activity from the city library", async ({ page }) => {
  await page.goto("/routes/route-main");
  const ckg = page.locator('[data-testid="stop-card"][data-city="CKG"]');
  await ckg.getByRole("button", { name: /^Activities \(\d+ in Chongqing\)$/ }).click();
  const drawer = page.getByRole("dialog", { name: "Activities in Chongqing" });
  // The checkbox is controlled by the optimistic update, which lands a tick after
  // the click, so click and then wait for it rather than using check().
  const hotpot = drawer.getByRole("checkbox", { name: "Plan Chongqing hotpot for this stop" });
  await hotpot.click();
  await expect(hotpot).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(ckg).toContainText("Chongqing hotpot");
  await page.reload();
  await expect(page.locator('[data-testid="stop-card"][data-city="CKG"]')).toContainText("Chongqing hotpot");
});

test("route editor fits a phone screen @phone", async ({ page }) => {
  await page.goto("/routes/route-main");
  await expect(page.getByTestId("stop-card").first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Booked tab lists the route's bookings and what is still to book", async ({ page }) => {
  await page.goto("/trips/asia-2027");
  await page.getByRole("link", { name: "Booked", exact: true }).click();
  await expect(page).toHaveURL(/\/trips\/asia-2027\/bookings/);
  await expect(page.getByLabel("Route")).toBeVisible();
  await expect(page.getByTestId("to-book")).toBeVisible();
  await expect(page.getByTestId("to-book").locator('a[data-provider="booking"]').first()).toHaveAttribute("href", /booking\.com\/searchresults/);
  await page.getByLabel("Route").selectOption("route-with-shanghai");
  await expect(page).toHaveURL(/route=route-with-shanghai/);
});

test("Inbox turns a pasted link into an activity idea", async ({ page }) => {
  await page.goto("/trips/asia-2027");
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(page).toHaveURL(/\/trips\/asia-2027\/inbox/);
  await page.getByLabel("Paste a confirmation or a link").fill("Night view from Shibuya Sky in Tokyo\nhttps://www.youtube.com/watch?v=e2e123");
  await page.getByRole("button", { name: "Read it" }).click();
  const item = page.getByTestId("inbox-item").filter({ hasText: "Night view from Shibuya Sky in Tokyo" });
  await expect(item).toHaveAttribute("data-status", "applied");
  await expect(item).toContainText("Tokyo (stop 1)");
});

test("pin an activity by hand and see its map links", async ({ page }) => {
  await page.goto("/trips/asia-2027/library");
  await page.getByRole("combobox", { name: "Filter by city" }).selectOption("CKG");
  const item = page.getByTestId("activity-item").first();
  await expect(item.getByTestId("place-links").locator('[data-kind="google-maps"]')).toBeVisible();
  await item.getByRole("button", { name: /on the map$/ }).click();
  const editor = item.getByTestId("place-editor");
  await editor.getByRole("textbox", { name: /Pin location/ }).fill("29.5536, 106.5418");
  await editor.getByRole("button", { name: "Set pin" }).click();
  await expect(editor.getByTestId("place-status")).toHaveText("Pinned by hand");
  // China stops also open in Apple Maps and, once pinned, Amap.
  await expect(item.getByTestId("place-links").locator('[data-kind="amap"]')).toHaveAttribute("href", /position=106\.5418%2C29\.5536/);
  await expect(item.getByTestId("place-links").locator('[data-kind="apple-maps"]')).toBeVisible();
});

test("itinerary lists the route day by day and puts an activity on a day", async ({ page }) => {
  await page.goto("/trips/asia-2027/itinerary?route=route-main");
  const days = page.getByTestId("itinerary-day");
  await expect(days.first()).toBeVisible();
  expect(await days.count()).toBeGreaterThan(35);
  await expect(days.first()).toHaveAttribute("data-kind", "travel");
  // Chongqing hotpot was planned earlier in this run without a day.
  const tray = page.getByTestId("unscheduled").filter({ hasText: "Chongqing" });
  const hotpot = tray.getByTestId("itinerary-item").filter({ hasText: "Chongqing hotpot" });
  await hotpot.getByRole("combobox", { name: "Day for Chongqing hotpot" }).selectOption({ index: 1 });
  const ckgDay = page.locator('[data-testid="itinerary-day"]').filter({ has: page.getByTestId("itinerary-item").filter({ hasText: "Chongqing hotpot" }) });
  await expect(ckgDay).toContainText("Chongqing");
  await expect(page.getByTestId("unscheduled").filter({ hasText: "Chongqing hotpot" })).toHaveCount(0);
});

test("Map tab lists pinned places and shows the assistant's focus", async ({ page }) => {
  await page.goto("/trips/asia-2027/map?route=route-main");
  await expect(page.getByTestId("map-region")).toBeVisible();
  const list = page.getByTestId("map-list");
  await expect(list).toBeVisible();
  await expect(list.locator('[data-type="stop"]').first()).toBeVisible();
  // The Chongqing activity pinned by hand earlier in this run is the only placed one there.
  const pinned = list.locator('[data-testid="map-list-item"][data-type="activity"][data-city="CKG"]').first();
  await expect(pinned).toBeVisible();
  await expect(page.getByTestId("map-unplaced")).toContainText("Not on the map yet:");
  await pinned.click();
  await expect(page.getByTestId("map-card").getByTestId("place-links").locator('[data-kind="google-maps"]')).toBeVisible();

  const nodeId = await pinned.getAttribute("data-node-id");
  expect(nodeId).toMatch(/^act:/);
  await page.goto(`/trips/asia-2027/map?route=route-main&focus=${encodeURIComponent(`${nodeId},act:not-a-real-id`)}`);
  await expect(page.getByTestId("map-focus-bar")).toContainText("Showing 1 place from the assistant");
  await expect(page.locator(`[data-testid="map-list-item"][data-node-id="${nodeId}"]`)).toHaveAttribute("data-focused", "true");
  await page.getByTestId("map-focus-bar").getByRole("button", { name: "Show everything" }).click();
  await expect(page.getByTestId("map-focus-bar")).toHaveCount(0);
  await expect(page).not.toHaveURL(/focus=/);
});

test("itinerary makes a private calendar link to subscribe to", async ({ page, request }) => {
  await page.goto("/trips/asia-2027/itinerary");
  await page.getByRole("button", { name: "Add to calendar" }).click();
  const panel = page.getByTestId("calendar-panel");
  await expect(panel.getByRole("checkbox", { name: /Include booking references/ })).not.toBeChecked();
  await panel.getByRole("button", { name: "Make my calendar link" }).click();
  const link = panel.getByTestId("calendar-link");
  await expect(link).toHaveText(/^webcal:\/\/.+\/cal\/[A-Za-z0-9_-]{43}\.ics$/);
  await expect(panel.getByRole("link", { name: "Google Calendar" })).toHaveAttribute("href", /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal/);
  await expect(panel.getByRole("link", { name: "Apple Calendar" })).toHaveAttribute("href", /^webcal:\/\//);
  const feed = await request.get(`${E2E_API_URL}${new URL((await link.textContent())!.replace(/^webcal:/, "http:")).pathname}`);
  expect(feed.status()).toBe(200);
  expect(await feed.text()).toContain("BEGIN:VEVENT");
});

test("Ask opens the trip assistant panel, which says when asking is off @phone", async ({ page }) => {
  await page.goto("/trips/asia-2027/bookings");
  await page.getByTestId("ask-button").click();
  const panel = page.getByTestId("assistant-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("assistant-off")).toContainText("turned off");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});
