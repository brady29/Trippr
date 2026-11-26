import type { RouteView } from "@trippr/contracts";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_API_URL, E2E_OWNER_INVITE } from "../playwright.config";

/** Where the money goes, and a budget target with ways back under it. */
test.describe.configure({ mode: "serial" });

let token = "";
let tripId = "";
let routeId = "";
const auth = () => ({ authorization: `Bearer ${token}` });

async function api<T>(request: APIRequestContext, method: "get" | "post" | "put" | "patch", path: string, data?: unknown): Promise<T> {
  const res = await request[method](`${E2E_API_URL}${path}`, { headers: auth(), data });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Owner" } });
  token = (await login.json()).token;
  const accept = await request.post(`${E2E_API_URL}/invites/${E2E_OWNER_INVITE}/accept`, { headers: auth() });
  expect([200, 404]).toContain(accept.status());
  // A trip of its own, so the budget doesn't touch the shared one: Tokyo and Osaka with stay estimates.
  const trip = await api<{ id: string; routeId: string }>(request, "post", "/trips", {
    name: "Budget test",
    startDate: "2027-09-01",
    travellers: 2,
    mustDos: [
      { cityCode: "TYO", title: "Tokyo Game Show", from: "2027-09-03", to: "2027-09-03" },
      { cityCode: "OSA", title: "Kishiwada Danjiri", from: "2027-09-10", to: "2027-09-10" },
    ],
  });
  tripId = trip.id;
  routeId = trip.routeId;
  let view = await api<RouteView>(request, "get", `/routes/${routeId}`);
  const [tyo, osa] = view.stops;
  view = await api<RouteView>(request, "patch", `/stops/${tyo!.id}`, { stayCadPerNight: 200, arriveCostCad: 900, version: view.route.version });
  await api<RouteView>(request, "patch", `/stops/${osa!.id}`, { stayCadPerNight: 60, version: view.route.version });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
});

test("the flow splits the money by kind and by city", async ({ page }) => {
  await page.goto(`/trips/${tripId}/routes/${routeId}`);
  const flow = page.getByTestId("budget-flow");
  await expect(flow.getByTestId("flow-band").first()).toBeVisible();
  await expect(flow.locator("svg")).toHaveAttribute("aria-label", /Stays .*Getting around/);
  await flow.getByRole("tab", { name: "All 2" }).click();
  await expect(flow).toContainText("All 2");
});

test("a budget target over the plan shows the gap and a fix that keeps every booking", async ({ page }) => {
  await page.goto(`/trips/${tripId}/routes/${routeId}`);
  const flow = page.getByTestId("budget-flow");
  const total = Number((await page.getByTestId("budget-per-person").innerText()).replace(/[^\d.]/g, ""));
  await flow.getByLabel("Budget per person").fill(String(Math.round(total - 120)));
  await flow.getByRole("button", { name: "Set" }).click();
  await expect(flow.getByTestId("over-budget")).toContainText("per person over budget");
  await expect(flow.getByTestId("budget-tick")).toHaveCount(1);
  const fix = flow.getByTestId("budget-fix").first();
  await expect(fix).toContainText(/saves \$/);
  await fix.click();
  await expect(flow.getByTestId("under-budget")).toContainText("under budget");
  await expect(page.getByTestId("change-bar")).toBeVisible();
});
