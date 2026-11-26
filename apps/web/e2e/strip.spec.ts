import type { Area, Hotel, RouteView } from "@trippr/contracts";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_API_URL, E2E_OWNER_INVITE } from "../playwright.config";

/** The trip strip you can drag, busy holidays on it, and cancellation deadlines. */
test.describe.configure({ mode: "serial" });

let token = "";
let routeId = "";
const auth = () => ({ authorization: `Bearer ${token}` });
const iso = (d: Date) => d.toISOString().slice(0, 10);

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
  let view = await api<RouteView>(request, "post", "/trips/asia-2027/routes", { fromRouteId: "route-main", name: "Strip e2e" });
  routeId = view.route.id;
  // A hotel in Xi'an booked for the plan's dates, free to cancel for five more days.
  const sia = view.stops.find((s) => s.city.code === "SIA")!;
  const [area] = await api<Area[]>(request, "get", "/cities/SIA/areas?tripId=asia-2027");
  const hotel = await api<Hotel>(request, "post", "/hotels", { tripId: "asia-2027", areaId: area!.id, name: "Bell Tower Hotel", priceCadPerNight: 70 });
  const soon = iso(new Date(Date.now() + 5 * 86_400_000));
  view = await api<RouteView>(request, "put", `/stops/${sia.id}/stays/${hotel.id}`, { status: "booked", freeCancelUntil: soon, version: view.route.version });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
});

const open = (page: Page) => page.goto(`/trips/asia-2027/routes/${routeId}`);
const nights = (page: Page, city: string) => page.locator(`[data-testid="stop-card"][data-city="${city}"]`).getByTestId("stop-nights");
const handle = (page: Page, i: number) => page.locator(`[data-testid="strip-handle"][data-index="${i}"]`);

test("dragging the line between two stops moves a night, with Undo", async ({ page }) => {
  await open(page);
  await expect(nights(page, "TYO")).toHaveText("4 nights");
  const box = (await handle(page, 0).boundingBox())!;
  const strip = (await page.getByTestId("trip-strip").boundingBox())!;
  const perDay = (strip.width - 48) / 40;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + perDay * 1.1, box.y + box.height / 2, { steps: 6 });
  await expect(page.getByTestId("strip-status")).toContainText("A night from Beijing to Tokyo");
  await page.mouse.up();
  await expect(nights(page, "TYO")).toHaveText("5 nights");
  await expect(nights(page, "BJS")).toHaveText("4 nights");
  await page.getByTestId("undo").click();
  await expect(nights(page, "TYO")).toHaveText("4 nights");
});

test("the keyboard moves a line too, and a booked date asks first, saying it's still free to change", async ({ page }) => {
  await open(page);
  await handle(page, 0).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(nights(page, "TYO")).toHaveText("3 nights");
  await expect(nights(page, "BJS")).toHaveText("6 nights");
  await page.getByTestId("undo").click();
  await expect(nights(page, "TYO")).toHaveText("4 nights");

  // The line between Beijing and Xi'an is held by the hotel's check-in.
  await handle(page, 1).focus();
  await page.keyboard.press("ArrowRight");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Bell Tower Hotel would no longer match its booked dates");
  await expect(dialog).toContainText("You can still change it for free");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(nights(page, "BJS")).toHaveText("5 nights");
});

test("a free-cancellation deadline tops Next to book, and the pin says so", async ({ page }) => {
  await open(page);
  const first = page.getByTestId("next-item").first();
  await expect(first).toHaveAttribute("data-kind", "deadline");
  await expect(first).toContainText("Free cancellation on Bell Tower Hotel ends");
  await expect(first).toContainText("5 days left to cancel for free");
  await expect(page.locator('[data-testid="stop-card"][data-city="SIA"]').getByTestId("pin")).toContainText("free to cancel until");
});

test("busy holidays show on the strip", async ({ page, request }) => {
  const trip = await api<{ id: string; routeId: string }>(request, "post", "/trips", {
    name: "Golden Week test",
    startDate: "2027-04-26",
    latestReturn: "2027-05-08",
    mustDos: [{ cityCode: "TYO", title: "Kanda Matsuri", from: "2027-05-01", to: "2027-05-01" }],
  });
  await page.goto(`/trips/${trip.id}/routes/${trip.routeId}`);
  await expect(page.getByTestId("busy-period").filter({ hasText: "Golden Week" })).toBeVisible();
});
