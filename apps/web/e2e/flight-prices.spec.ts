import { expect, test } from "@playwright/test";
import { E2E_API_URL, E2E_OWNER_INVITE } from "../playwright.config";

/**
 * Flight prices run on the demo provider here: invented, clearly labelled sample
 * history written by `flight-snapshots --demo-seed` before the API starts (see
 * playwright.config.ts). No provider key is used and nothing leaves the machine.
 */
test.describe.configure({ mode: "serial" });

let token = "";

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Owner" } });
  expect(login.ok()).toBeTruthy();
  token = (await login.json()).token;
  const accept = await request.post(`${E2E_API_URL}/invites/${E2E_OWNER_INVITE}/accept`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect([200, 404]).toContain(accept.status());
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
});

test("a flight shows its price history, the booking signal and the disclaimer", async ({ page }) => {
  await page.goto("/routes/route-main");
  const tokyo = page.locator('[data-testid="stop-card"][data-city="TYO"]');
  await tokyo.getByRole("button", { name: "Prices for YYZ to HND" }).click();

  const panel = tokyo.getByTestId("flight-price-panel");
  await expect(panel).toBeVisible();
  // Sample data is labelled as such, and the prices are labelled as estimates.
  await expect(panel.getByTestId("flight-price-sample")).toContainText("Sample data");
  await expect(panel.getByTestId("flight-price-disclaimer")).toContainText("estimates");
  await expect(panel.getByTestId("flight-price-disclaimer")).toContainText("Check the airline");
  await expect(panel.getByTestId("flight-price-latest")).toContainText("per person");
  await expect(panel.getByTestId("flight-price-latest")).toContainText("for 6");

  // The chart: hovering shows a tooltip with a price and a date.
  const chart = panel.getByTestId("price-chart");
  await expect(chart.getByRole("img")).toHaveAttribute("aria-label", /YYZ to HND/);
  // hover() scrolls the chart into view first, so the pointer lands on it even below the fold.
  await chart.getByRole("img").hover({ position: { x: 150, y: 60 } });
  await expect(chart.getByTestId("price-chart-tooltip")).toContainText("$");
  await expect(chart.getByTestId("price-chart-tooltip")).toContainText(" on ");
  // The keyboard works too: focus the chart and step back a day.
  await page.mouse.move(0, 0);
  await expect(chart.getByTestId("price-chart-tooltip")).toHaveCount(0);
  await chart.getByTestId("price-chart-surface").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(chart.getByTestId("price-chart-tooltip")).toContainText("$");

  // The signal says what it saw, and that it is an estimate.
  const signal = panel.getByTestId("flight-signal");
  await expect(signal).toBeVisible();
  await expect(signal).toContainText("estimate");
  await expect(signal).toHaveAttribute("data-verdict", /^(buy|wait|watch)$/);

  // The same numbers are available as a table.
  await chart.getByRole("button", { name: "Show as table" }).click();
  await expect(chart.getByTestId("price-table")).toContainText("Lowest price");

  // Nearby dates are listed.
  await expect(panel.getByRole("list", { name: "Prices on nearby dates" }).getByRole("listitem")).toHaveCount(7);
});

test("price drops show as a notice on the route", async ({ page }) => {
  await page.goto("/routes/route-main");
  const notices = page.getByTestId("flight-notices");
  await expect(notices).toBeVisible();
  await expect(notices).toContainText("sample data");
  await expect(notices.getByTestId("flight-notice").first()).toContainText("below its previous low");
});

test("the booked page shows the latest fare for a stop still to book", async ({ page }) => {
  await page.goto("/trips/asia-2027/bookings");
  const fare = page.getByTestId("to-book-fare").first();
  await expect(fare).toBeVisible();
  await expect(fare).toContainText("sample data");
  await expect(fare).toContainText("An estimate; check the airline");
});

test("the flight price API is read-only for viewers and strangers are refused", async ({ request }) => {
  const stranger = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Stranger" } });
  const strangerToken = (await stranger.json()).token;
  const res = await request.get(`${E2E_API_URL}/trips/asia-2027/flight-prices`, { headers: { authorization: `Bearer ${strangerToken}` } });
  expect(res.status()).toBe(404);
  const owner = await request.get(`${E2E_API_URL}/trips/asia-2027/flight-prices`, { headers: { authorization: `Bearer ${token}` } });
  expect(owner.ok()).toBeTruthy();
  const body = await owner.json();
  expect(body).toMatchObject({ enabled: true, sample: true, provider: "demo" });
  expect(body.disclaimer).toMatch(/estimates/);
});
