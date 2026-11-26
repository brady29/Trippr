import type { RouteView } from "@trippr/contracts";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_API_URL, E2E_OWNER_INVITE } from "../playwright.config";

/** The line map, Compare's two-route map, and "Suggest a better order". */
test.describe.configure({ mode: "serial" });

let token = "";
let scrambled = "";
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
  // A copy of Main with its order scrambled: Tokyo, Bali, Beijing, Ho Chi Minh City, ...
  const view = await api<RouteView>(request, "post", "/trips/asia-2027/routes", { fromRouteId: "route-main", name: "Scrambled e2e" });
  scrambled = view.route.id;
  const by = Object.fromEntries(view.stops.map((s) => [s.city.code, s.id]));
  const order = ["TYO", "DPS", "BJS", "SGN", "SIA", "HAN", "CKG", "KOM", "CAN", "HKG", "SZX"].map((c) => by[c]!);
  await api(request, "put", `/routes/${scrambled}/order`, { stopIds: order, version: view.route.version });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
});

test("the sidebar switches to a line map, remembers it, and a station jumps to its stop", async ({ page }) => {
  await page.goto("/trips/asia-2027/routes/route-main");
  await page.getByTestId("view-line").click();
  const map = page.getByTestId("line-map");
  await expect(map.getByTestId("line-station")).toHaveCount(11);
  await expect(map).toHaveAttribute("aria-label", /Tokyo, Beijing, Xi'an/);
  await page.reload();
  await expect(page.getByTestId("view-line")).toHaveAttribute("aria-selected", "true");
  await map.locator('[data-testid="line-station"][data-city="HKG"]').click();
  await expect(page.locator('[data-testid="stop-card"][data-city="HKG"]')).toBeInViewport();
  await page.getByTestId("view-map").click();
});

test("Compare draws both routes on one line map, sharing stations", async ({ page }) => {
  await page.goto("/trips/asia-2027/compare?a=route-main&b=route-with-shanghai");
  const map = page.getByTestId("compare-line-map").getByTestId("line-map");
  await expect(map.locator('[data-testid="line-station"][data-city="SHA"]')).toBeVisible();
  await expect(map.locator('[data-testid="line-station"][data-city="TYO"]')).toHaveAttribute("aria-label", /on both routes/);
});

test("a scrambled route gets a better order, applied with Undo", async ({ page }) => {
  await page.goto(`/trips/asia-2027/routes/${scrambled}`);
  const cities = () => page.getByTestId("stop-card").evaluateAll((cards) => cards.map((c) => (c as HTMLElement).dataset.city));
  await expect.poll(cities).toEqual(["TYO", "DPS", "BJS", "SGN", "SIA", "HAN", "CKG", "KOM", "CAN", "HKG", "SZX"]);
  await page.getByTestId("suggest-order").click();
  const panel = page.getByTestId("better-order");
  await expect(panel.getByTestId("order-saves")).toContainText(/Saves about [\d,]+ km/);
  await expect(panel.getByTestId("line-ghost")).toBeVisible();
  await panel.getByTestId("apply-order").click();
  await expect(page.getByTestId("change-bar")).toContainText("Reordered to save about");
  await expect.poll(async () => (await cities())[0]).toBe("TYO");
  await expect.poll(async () => (await cities()).indexOf("DPS")).toBeGreaterThan(5);
  await page.getByTestId("undo").click();
  await expect.poll(cities).toEqual(["TYO", "DPS", "BJS", "SGN", "SIA", "HAN", "CKG", "KOM", "CAN", "HKG", "SZX"]);
});

test("Main is already in a sensible order", async ({ page }) => {
  await page.goto("/trips/asia-2027/routes/route-main");
  await page.getByTestId("suggest-order").click();
  await expect(page.getByTestId("better-order")).toContainText(/already the shortest order|Saves about/);
});
