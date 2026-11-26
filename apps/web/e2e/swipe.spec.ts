import type { RouteView } from "@trippr/contracts";
import { expect, test, type Page } from "@playwright/test";
import { E2E_API_URL, E2E_OWNER_INVITE } from "../playwright.config";

/** Swipe to vote, the group taste charts and the split-flap boards. */
test.describe.configure({ mode: "serial" });

let token = "";

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Owner" } });
  token = (await login.json()).token;
  const accept = await request.post(`${E2E_API_URL}/invites/${E2E_OWNER_INVITE}/accept`, { headers: { authorization: `Bearer ${token}` } });
  expect([200, 404]).toContain(accept.status());
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
});

const cardTitle = (page: Page) => page.getByTestId("swipe-card").locator("h2").innerText();

async function openCity(page: Page, name: string) {
  await page.goto("/trips/asia-2027/swipe");
  await page.getByRole("tab", { name }).click();
  await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("swipe-card")).toBeVisible();
}

test("swipe with the keyboard, undo, drag, and must do plans the idea", async ({ page, request }) => {
  await openCity(page, "Xi'an");
  const first = await cardTitle(page);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("swipe-status")).toContainText(`Yes to ${first}`);
  await expect.poll(() => cardTitle(page)).not.toBe(first);

  await page.keyboard.press("u");
  await expect(page.getByTestId("swipe-status")).toContainText(`Undone: ${first} is back`);
  await expect.poll(() => cardTitle(page)).toBe(first);

  // Drag it most of the way left: a no.
  const box = (await page.getByTestId("swipe-card").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - box.width * 0.6, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("swipe-status")).toContainText(`No to ${first}`);

  const second = await cardTitle(page);
  await page.getByRole("button", { name: /^Must do/ }).click();
  await expect(page.getByTestId("swipe-status")).toContainText(`Must do to ${second}, planned in Xi'an`);
  const view = (await (await request.get(`${E2E_API_URL}/routes/route-main`, { headers: { authorization: `Bearer ${token}` } })).json()) as RouteView;
  expect(view.stops.find((s) => s.city.code === "SIA")!.planned.map((p) => p.title)).toContain(second);

  // Skip the rest until the city runs out.
  for (let i = 0; i < 40 && (await page.getByTestId("swipe-card").count()); i++) await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("swipe-done")).toContainText("That's every idea in Xi'an");
  await page.getByRole("button", { name: /^Next: / }).click();
  await expect(page.getByRole("tab", { name: "Chongqing" })).toHaveAttribute("aria-selected", "true");
});

test("the group taste charts show counts, never who voted", async ({ page, request }) => {
  await page.goto("/trips/asia-2027/swipe");
  const taste = page.getByTestId("group-taste");
  await expect(taste.getByTestId("consensus-chart").locator("g[role=img]").first()).toBeVisible();
  await expect(taste.getByTestId("taste-radar")).toBeVisible();
  await expect(taste.getByTestId("taste-radar")).toHaveAttribute("aria-label", /for you/);
  // The API gives counts only.
  const page1 = await (await request.get(`${E2E_API_URL}/trips/asia-2027/activities/page?scope=mine&limit=5`, { headers: { authorization: `Bearer ${token}` } })).json();
  for (const item of page1.items) {
    expect(typeof item.ups).toBe("number");
    expect(JSON.stringify(item)).not.toMatch(/voters|votedBy|userId/);
  }
  await page.goto("/trips/asia-2027/library");
  await page.getByTestId("taste-toggle").click();
  await expect(page.getByTestId("group-taste")).toBeVisible();
});

test("board titles turn like split flaps and land on the text", async ({ page }) => {
  await page.goto("/trips/asia-2027/bookings");
  const tiles = page.locator("h1").getByTestId("flap");
  await expect.poll(async () => (await tiles.allInnerTexts()).join("")).toBe("BOOKINGS");
});

test("with reduced motion the board shows the text at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/trips/asia-2027/bookings");
  const tiles = page.locator("h1").getByTestId("flap");
  await expect(tiles.first()).toBeVisible();
  expect((await tiles.allInnerTexts()).join("")).toBe("BOOKINGS");
});
