import { expect, test } from "@playwright/test";
import { E2E_API_URL, E2E_OWNER_INVITE } from "../playwright.config";

/**
 * Trip Graph Explorer smoke tests, against the real API's GET /trips/:id/graph.
 * Counts are read from the API rather than hard-coded, so other tests'
 * changes to the seeded trip don't break these.
 */
test.describe.configure({ mode: "serial" });

const TRIP = "asia-2027";
const ROUTE = "route-with-shanghai";
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

async function apiGraph(request: import("@playwright/test").APIRequestContext, query: string) {
  const res = await request.get(`${E2E_API_URL}/trips/${TRIP}/graph?${query}`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { nodes: { id: string; type: string; style: { tag?: string; tags?: string[] } }[] };
}

test("the Graph tab opens the explorer", async ({ page }) => {
  await page.goto(`/trips/${TRIP}`);
  await page.getByRole("link", { name: "Graph", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/trips/${TRIP}/graph`));
  await expect(page.getByTestId("graph-view-toggle")).toBeVisible();
});

test("the list fallback shows every node the API returns for the scope", async ({ page, request }) => {
  const graph = await apiGraph(request, `scope=route&routeId=${ROUTE}`);
  await page.goto(`/trips/${TRIP}/graph?view=list&scope=route&route=${ROUTE}`);
  await expect(page.getByTestId("graph-list-row")).toHaveCount(graph.nodes.length);
});

test("filtering by a tag changes the count", async ({ page, request }) => {
  const graph = await apiGraph(request, `scope=route&routeId=${ROUTE}`);
  const activities = graph.nodes.filter((n) => n.type === "activity");
  const culture = activities.filter((n) => (n.style.tags ?? []).includes("culture") || n.style.tag === "culture");
  test.skip(activities.length === 0 || culture.length === activities.length, "needs a mix of activity tags");
  await page.goto(`/trips/${TRIP}/graph?view=list&scope=route&route=${ROUTE}`);
  await expect(page.getByTestId("graph-list-row")).toHaveCount(graph.nodes.length);
  await page.getByRole("button", { name: /^Filters and key/ }).click();
  await page.getByRole("group", { name: "Activity tags" }).getByRole("button", { name: /Culture/ }).click();
  await expect(page.getByTestId("graph-list-row")).toHaveCount(graph.nodes.length - activities.length + culture.length);
  await expect(page).toHaveURL(/tags=culture/);
});

test("a focus deep link opens the details panel", async ({ page, request }) => {
  const graph = await apiGraph(request, `scope=route&routeId=${ROUTE}`);
  const city = graph.nodes.find((n) => n.type === "city");
  expect(city).toBeTruthy();
  await page.goto(`/trips/${TRIP}/graph?scope=route&route=${ROUTE}&focus=${encodeURIComponent(city!.id)}`);
  await expect(page.getByTestId("graph-details")).toBeVisible();
  await expect(page.getByTestId("graph-canvas-2d")).toBeVisible();
});

test("the 3D globe mounts a canvas, or falls back to the list", async ({ page }) => {
  const lost: string[] = [];
  page.on("console", (m) => {
    if (/webglcontextlost/i.test(m.text())) lost.push(m.text());
  });
  await page.goto(`/trips/${TRIP}/graph?view=3d&scope=route&route=${ROUTE}`);
  const globe = page.getByTestId("graph-globe");
  const list = page.getByTestId("graph-list");
  await expect(globe.or(list)).toBeVisible({ timeout: 20_000 });
  if (await list.isVisible()) return; // No WebGL in this browser: the list fallback is the right outcome.

  const canvas = globe.locator("canvas.maplibregl-canvas");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(3000);
  expect(lost).toEqual([]);
  // More than 5% of the canvas is not the plain background.
  const png = await canvas.screenshot();
  const share = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const [r0, g0, b0] = [data[0]!, data[1]!, data[2]!];
    let differ = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i]! - r0) + Math.abs(data[i + 1]! - g0) + Math.abs(data[i + 2]! - b0) > 24) differ++;
    }
    return differ / (data.length / 4);
  }, png.toString("base64"));
  expect(share).toBeGreaterThan(0.05);
});
