import type { Area, Hotel, RouteView } from "@trippr/contracts";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_API_URL, E2E_OWNER_INVITE } from "../playwright.config";

/**
 * Booked dates as anchors: on a copy of Main with a hotel booked in Xi'an,
 * the route builder protects the booking. One more night in Beijing offers a
 * trade with Tokyo, a night in Xi'an itself means moving the booking, and
 * every change can be undone.
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

  let view = await api<RouteView>(request, "post", "/trips/asia-2027/routes", { fromRouteId: "route-main", name: "Anchors e2e" });
  routeId = view.route.id;
  const sia = view.stops.find((s) => s.city.code === "SIA")!;
  const [area] = await api<Area[]>(request, "get", "/cities/SIA/areas?tripId=asia-2027");
  const hotel = await api<Hotel>(request, "post", "/hotels", { tripId: "asia-2027", areaId: area!.id, name: "Courtyard Inn", priceCadPerNight: 90 });
  view = await api<RouteView>(request, "put", `/stops/${sia.id}/stays/${hotel.id}`, { status: "booked", version: view.route.version });
  expect(view.stops.find((s) => s.id === sia.id)!.stays[0]).toMatchObject({ status: "booked", arrive: sia.arrive, depart: sia.depart });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
});

const card = (page: Page, city: string) => page.locator(`[data-testid="stop-card"][data-city="${city}"]`);
const nights = (page: Page, city: string) => card(page, city).getByTestId("stop-nights");

test("a booked hotel locks its stop and pins its dates", async ({ page }) => {
  await page.goto(`/trips/asia-2027/routes/${routeId}`);
  await expect(card(page, "SIA")).toHaveAttribute("data-lock", "booked");
  const pin = card(page, "SIA").getByTestId("pin");
  await expect(pin).toContainText("Courtyard Inn");
  await expect(pin).toHaveAttribute("data-holds", "true");
  await expect(card(page, "BJS")).toHaveAttribute("data-lock", "free");
});

test("one more night before a booking offers a trade, and Undo puts it back", async ({ page }) => {
  await page.goto(`/trips/asia-2027/routes/${routeId}`);
  const siaDates = await card(page, "SIA").getByTestId("stop-dates").innerText();
  await expect(nights(page, "BJS")).toHaveText("5 nights");

  await card(page, "BJS").getByRole("button", { name: "One more night in Beijing" }).click();
  const panel = card(page, "BJS").getByTestId("trade-panel");
  await expect(panel).toContainText("can't get another night without moving a booking");
  await expect(panel.getByTestId("trade-option").first()).toContainText("Take a night from Tokyo");
  // Nothing has changed yet.
  await expect(nights(page, "BJS")).toHaveText("5 nights");

  await panel.getByTestId("trade-option").first().click();
  await expect(nights(page, "BJS")).toHaveText("6 nights");
  await expect(nights(page, "TYO")).toHaveText("3 nights");
  await expect(card(page, "SIA").getByTestId("stop-dates")).toHaveText(siaDates);
  const bar = page.getByTestId("change-bar");
  await expect(bar).toContainText("Beijing 5 → 6 nights");
  await expect(bar).toContainText("Tokyo 4 → 3 nights");
  await expect(bar).toContainText("no bookings moved");

  await bar.getByTestId("undo").click();
  await expect(nights(page, "BJS")).toHaveText("5 nights");
  await expect(nights(page, "TYO")).toHaveText("4 nights");
  await expect(bar).toContainText("Undone");
  // Saved on the server, not only on screen.
  await page.reload();
  await expect(nights(page, "TYO")).toHaveText("4 nights");
});

test("changing the booked stop itself means moving the booking, and says so", async ({ page }) => {
  await page.goto(`/trips/asia-2027/routes/${routeId}`);
  await card(page, "SIA").getByRole("button", { name: "One more night in Xi'an" }).click();
  const panel = card(page, "SIA").getByTestId("trade-panel");
  await expect(panel).toContainText("Courtyard Inn is booked for 3 nights");
  await expect(panel.getByTestId("trade-option")).toHaveCount(0);

  await panel.getByTestId("shift-option").click();
  await expect(nights(page, "SIA")).toHaveText("4 nights");
  await expect(card(page, "SIA").getByTestId("pin")).toHaveAttribute("data-holds", "false");
  await expect(page.getByTestId("change-bar")).toContainText("Courtyard Inn is now off its booked dates");

  await page.getByTestId("undo").click();
  await expect(card(page, "SIA").getByTestId("pin")).toHaveAttribute("data-holds", "true");
});

test("a change after the last booking saves straight away", async ({ page }) => {
  await page.goto(`/trips/asia-2027/routes/${routeId}`);
  await card(page, "DPS").getByRole("button", { name: "One more night in Bali" }).click();
  await expect(page.getByTestId("trade-panel")).toHaveCount(0);
  await expect(page.getByTestId("change-bar")).toContainText("home");
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("change-bar")).toContainText("Undone");
});

test("moving a stop across a booking asks first, and Cancel leaves it", async ({ page }) => {
  await page.goto(`/trips/asia-2027/routes/${routeId}`);
  await expect(page.getByTestId("stop-card")).toHaveCount(11);
  const order = await page.getByTestId("stop-card").evaluateAll((cards) => cards.map((c) => (c as HTMLElement).dataset.city));
  await card(page, "CKG").getByRole("button", { name: "Move Chongqing earlier" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Moved Chongqing after Beijing?");
  await expect(dialog).toContainText("Courtyard Inn would no longer match its booked dates");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.getByTestId("stop-card").evaluateAll((cards) => cards.map((c) => (c as HTMLElement).dataset.city))).toEqual(order);
});

test("removing a stop says what it takes with it", async ({ page }) => {
  await page.goto(`/trips/asia-2027/routes/${routeId}`);
  await card(page, "SIA").getByRole("button", { name: "Remove Xi'an" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Its bookings go with it: Courtyard Inn");
  await expect(dialog).toContainText("can't be undone");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(card(page, "SIA")).toBeVisible();
});

test("the hotel drawer asks for and shows the booked dates", async ({ page }) => {
  await page.goto(`/trips/asia-2027/routes/${routeId}`);
  await card(page, "SIA").getByRole("button", { name: "Where to stay" }).click();
  const drawer = page.getByRole("dialog");
  const item = drawer.getByTestId("hotel-item").filter({ hasText: "Courtyard Inn" });
  await expect(item.getByTestId("booked-dates")).toContainText("May 19 → Sat May 22");
  await item.getByRole("button", { name: "Change dates" }).click();
  await item.getByLabel("Check-in at Courtyard Inn").fill("2027-05-20");
  await item.getByLabel("Check-out at Courtyard Inn").fill("2027-05-23");
  await item.getByRole("button", { name: "Save booking" }).click();
  await expect(item.getByTestId("booked-dates")).toContainText("May 20 → Sun May 23");
  await page.keyboard.press("Escape");
  // The plan now disagrees with the booking, and the stop shows it.
  await expect(card(page, "SIA").getByTestId("pin")).toHaveAttribute("data-holds", "false");
});
