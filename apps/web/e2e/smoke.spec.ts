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
  await page.getByLabel("Route").selectOption("route-with-shanghai");
  await expect(page).toHaveURL(/route=route-with-shanghai/);
});
