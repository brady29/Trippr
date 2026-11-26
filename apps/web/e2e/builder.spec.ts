import type { Area, Hotel, RouteView } from "@trippr/contracts";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_API_URL, E2E_OWNER_INVITE } from "../playwright.config";

/**
 * Slices 2 and 3 of the route builder, on a copy of Main: fixes on the stop
 * card, the ticket home, Next to book with "Did you book it?", smart add
 * stop, pace, the compact view and trip setup with must-dos.
 */
test.describe.configure({ mode: "serial" });

let token = "";
let routeId = "";
const auth = () => ({ authorization: `Bearer ${token}` });

async function api<T>(request: APIRequestContext, method: "get" | "post" | "put", path: string, data?: unknown): Promise<T> {
  const res = await request[method](`${E2E_API_URL}${path}`, { headers: auth(), data });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Owner" } });
  token = (await login.json()).token;
  const accept = await request.post(`${E2E_API_URL}/invites/${E2E_OWNER_INVITE}/accept`, { headers: auth() });
  expect([200, 404]).toContain(accept.status());

  let view = await api<RouteView>(request, "post", "/trips/asia-2027/routes", { fromRouteId: "route-main", name: "Builder e2e" });
  routeId = view.route.id;
  // A hotel in Xi'an booked a day later than the plan has it (May 20 to 23, plan May 19 to 22).
  const sia = view.stops.find((s) => s.city.code === "SIA")!;
  const [area] = await api<Area[]>(request, "get", "/cities/SIA/areas?tripId=asia-2027");
  const hotel = await api<Hotel>(request, "post", "/hotels", { tripId: "asia-2027", areaId: area!.id, name: "Drum Tower Inn", priceCadPerNight: 80 });
  view = await api<RouteView>(request, "put", `/stops/${sia.id}/stays/${hotel.id}`, { status: "booked", arrive: "2027-05-20", depart: "2027-05-23", version: view.route.version });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
});

const open = (page: Page) => page.goto(`/trips/asia-2027/routes/${routeId}`);
const card = (page: Page, city: string) => page.locator(`[data-testid="stop-card"][data-city="${city}"]`);

test("a hotel booked for other dates shows on its stop with a fix that keeps the other bookings", async ({ page }) => {
  await open(page);
  const sia = card(page, "SIA");
  await expect(sia.getByTestId("pin")).toHaveAttribute("data-holds", "false");
  const issue = sia.locator('[data-testid="issue"][data-kind="stay-dates"]');
  await expect(issue).toContainText("Drum Tower Inn is booked for other dates");
  const fix = issue.getByTestId("fix").first();
  await expect(fix).toHaveText(/^Move a night from .+ to .+$/);
  const home = await page.getByTestId("home-date").innerText();
  await fix.click();
  await expect(sia.getByTestId("pin")).toHaveAttribute("data-holds", "true");
  await expect(sia.getByTestId("stop-dates")).toContainText("Thu May 20");
  await expect(page.getByTestId("home-date")).toHaveText(home);
  await expect(page.getByTestId("change-bar")).toContainText("Drum Tower Inn back on its booked dates");
});

test("Next to book puts the flight home first, and 'Did you book it?' opens the form when you come back", async ({ page, context }) => {
  await open(page);
  const first = page.getByTestId("next-item").first();
  await expect(first).toHaveAttribute("data-kind", "home");
  await expect(first).toContainText("Flight home");
  // A stop whose hotel is booked never asks for one.
  await expect(page.locator('[data-testid="next-item"]').filter({ hasText: "Hotel in Xi'an" })).toHaveCount(0);

  // Open a search from a hotel item, come back, and say yes.
  await page.getByRole("button", { name: /^Show all/ }).click();
  const hotelItem = page.locator('[data-testid="next-item"][data-kind="stay"]').first();
  await hotelItem.getByRole("button", { name: "Search" }).click();
  const popup = context.waitForEvent("page");
  await hotelItem.getByRole("link").first().click();
  await (await popup).close();
  await page.waitForTimeout(1700);
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const prompt = page.getByTestId("booked-prompt");
  await expect(prompt).toContainText("Did you book the hotel in");
  await prompt.getByRole("button", { name: "Yes, add it" }).click();
  await expect(page.getByRole("dialog", { name: /^Where to stay in / })).toBeVisible();
  await page.keyboard.press("Escape");

  // "I booked it" on the flight home opens the ticket form in Getting home.
  await first.getByRole("button", { name: "I booked it" }).click();
  await expect(page.getByTestId("home-card").getByRole("button", { name: "Add leg", exact: true })).toBeVisible();
});

test("a booked flight home fixes the home date: the last stop has to trade", async ({ page, request }) => {
  const view = await api<RouteView>(request, "get", `/routes/${routeId}`);
  await api<RouteView>(request, "post", `/routes/${routeId}/home-legs`, {
    mode: "flight",
    from: { kind: "airport", id: "DPS" },
    to: { kind: "airport", id: "YYZ" },
    number: "QR 961",
    departAt: `${view.checks.returnDate}T18:40+08:00`,
    status: "booked",
    version: view.route.version,
  });
  await open(page);
  await expect(page.getByTestId("home-card")).toHaveAttribute("data-fixed", "true");
  await expect(page.getByTestId("home-pin")).toHaveAttribute("data-holds", "true");
  await card(page, "DPS").getByRole("button", { name: "One more night in Bali" }).click();
  const panel = card(page, "DPS").getByTestId("trade-panel");
  await expect(panel).toContainText("QR 961");
  await expect(panel.getByTestId("trade-option").first()).toContainText("Take a night from Komodo");
  await panel.getByRole("button", { name: /^Cancel/ }).click();
  await expect(page.locator('[data-testid="next-item"][data-kind="home"]')).toHaveCount(0);
});

test("smart add stop suggests where a city fits, and a trade so the flight home stays put", async ({ page }) => {
  await open(page);
  await page.getByRole("combobox", { name: "Search for a city to add" }).fill("Macau");
  await page.getByRole("option", { name: /Macau/ }).click();
  const preview = page.getByTestId("add-preview");
  await expect(preview).toContainText("Fits best between Hong Kong and Hanoi");
  await expect(preview).toContainText("1 night is suggested");
  await expect(page.getByRole("spinbutton", { name: "Nights" })).toHaveValue("1");
  await expect(preview).toContainText("would move QR 961 off its booked dates");
  await expect(preview.getByTestId("add-trade").first()).toBeVisible();
  const home = await page.getByTestId("home-date").innerText();
  await page.getByRole("button", { name: "Add stop" }).click();
  const cities = () => page.getByTestId("stop-card").evaluateAll((cards) => cards.map((c) => (c as HTMLElement).dataset.city));
  await expect.poll(async () => (await cities()).join(" ")).toContain("HKG MFM HAN");
  await expect(page.getByTestId("home-date")).toHaveText(home);
  await expect(page.getByTestId("home-pin")).toHaveAttribute("data-holds", "true");
});

test("pace and the compact view", async ({ page }) => {
  await open(page);
  await expect(card(page, "TYO").getByTestId("pace")).toBeVisible();
  await page.getByTestId("compact-toggle").click();
  await expect(card(page, "TYO")).toHaveAttribute("data-compact", "true");
  await expect(card(page, "SIA")).toContainText("booked");
  await card(page, "TYO").getByRole("button", { name: "Open Tokyo" }).click();
  await expect(card(page, "TYO")).not.toHaveAttribute("data-compact", "true");
  // Remembered for next time.
  await page.reload();
  await expect(card(page, "BJS")).toHaveAttribute("data-compact", "true");
  await page.getByTestId("compact-toggle").click();
  await expect(card(page, "BJS")).not.toHaveAttribute("data-compact", "true");
});

test("trip setup drafts a route around the must-dos and checks the home-by date", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Plan a new trip" }).click();
  await page.getByLabel("Trip name").fill("Kansai long weekend");
  await page.getByLabel("Starts").fill("2027-04-01");
  await page.getByLabel("Home by (optional)").fill("2027-04-08");
  await page.getByRole("button", { name: "Add a must-do" }).click();
  const row = page.getByTestId("must-dos").locator("li").first();
  await row.getByRole("combobox", { name: "City" }).fill("Kyoto");
  await page.getByRole("option", { name: /Kyoto/ }).click();
  await row.getByLabel("What").fill("Cherry blossoms at Maruyama");
  await row.getByLabel("On", { exact: true }).fill("2027-04-03");
  await page.getByRole("button", { name: /^Create trip and draft a route/ }).click();
  await expect(page).toHaveURL(/\/routes\//);
  const kyoto = page.locator('[data-testid="stop-card"][data-city="UKY"]');
  await expect(kyoto).toContainText("Cherry blossoms at Maruyama");
  await expect(kyoto.getByTestId("stop-nights")).toHaveText("7 nights");
  // Past the home-by date: the check says so, with a fix.
  await kyoto.getByRole("button", { name: "One more night in Kyoto" }).click();
  const issue = page.getByTestId("home-card").locator('[data-testid="issue"][data-kind="return-window"]');
  await expect(issue).toContainText("after your latest return");
  await issue.getByTestId("fix").first().click();
  await expect(issue).toHaveCount(0);
});
