import { expect, test, type Page } from "@playwright/test";
import { E2E_API_URL, E2E_OWNER_INVITE } from "../playwright.config";

/**
 * Quality checks across the planning pages: every control has a name, the
 * pages fit a phone without sideways scrolling, dialogs keep focus, saves
 * survive a dropped connection, and a nights change is quick.
 */
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

const PAGES = [
  ["route editor", "/trips/asia-2027/routes/route-main", '[data-testid="stop-card"]'],
  ["swipe", "/trips/asia-2027/swipe", '[data-testid="swipe-deck"]'],
  ["compare", "/trips/asia-2027/compare?a=route-main&b=route-with-shanghai", '[data-testid="compare-budget"]'],
  ["bookings", "/trips/asia-2027/bookings", '[data-testid="booking-progress"]'],
  ["my trips", "/", '[data-testid="trip-row"]'],
] as const;

/** Buttons, links and form fields with no accessible name, by a simple version of the browser's rules. */
async function unnamed(page: Page) {
  return page.evaluate(() => {
    const named = (el: Element) => {
      const h = el as HTMLElement;
      if (h.getAttribute("aria-hidden") === "true" || h.closest("[aria-hidden=true]")) return true;
      if (h.getAttribute("aria-label")?.trim()) return true;
      const by = h.getAttribute("aria-labelledby");
      if (by && by.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())) return true;
      if (h.textContent?.trim()) return true;
      if (h.getAttribute("title")?.trim()) return true;
      if ((h as HTMLInputElement).labels?.length) return true;
      if (h.getAttribute("placeholder")?.trim()) return true;
      if (h.querySelector("img[alt]:not([alt=''])")) return true;
      return false;
    };
    const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;
    return [...document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea")]
      .filter((el) => visible(el) && !named(el))
      .map((el) => el.outerHTML.slice(0, 120));
  });
}

for (const [name, url, ready] of PAGES) {
  test(`every control on ${name} has a name`, async ({ page }) => {
    await page.goto(url);
    await expect(page.locator(ready).first()).toBeVisible();
    expect(await unnamed(page)).toEqual([]);
  });

  test(`${name} fits a phone without sideways scrolling @phone`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await expect(page.locator(ready).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test("the stop dialog keeps focus inside and gives it back", async ({ page }) => {
  await page.goto("/trips/asia-2027/routes/route-main");
  const opener = page.locator('[data-testid="stop-card"][data-city="TYO"]').getByRole("button", { name: "Where to stay" });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("a change made while offline waits, then saves when the connection is back", async ({ page, context }) => {
  await page.goto("/trips/asia-2027/routes/route-main");
  const bali = page.locator('[data-testid="stop-card"][data-city="DPS"]');
  const before = Number((await bali.getByTestId("stop-nights").innerText()).split(" ")[0]);
  await context.setOffline(true);
  await bali.getByRole("button", { name: "One more night in Bali" }).click();
  await expect(page.getByTestId("offline-banner")).toContainText("You're offline");
  await expect(page.getByTestId("change-bar")).toContainText("Saving when you're back online");
  await context.setOffline(false);
  await expect(page.getByTestId("offline-banner")).toHaveCount(0, { timeout: 20_000 });
  await page.reload();
  await expect(page.locator('[data-testid="stop-card"][data-city="DPS"]').getByTestId("stop-nights")).toHaveText(`${before + 1} nights`);
  // Put it back.
  await page.locator('[data-testid="stop-card"][data-city="DPS"]').getByRole("button", { name: "One fewer night in Bali" }).click();
  await expect(page.getByTestId("change-bar")).toBeVisible();
});

test("a nights change shows on screen quickly", async ({ page }) => {
  await page.goto("/trips/asia-2027/routes/route-main");
  const card = page.locator('[data-testid="stop-card"][data-city="DPS"]');
  await expect(card.getByTestId("stop-nights")).toBeVisible();
  const ms = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="stop-card"][data-city="DPS"] [data-testid="stop-nights"]')!;
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="stop-card"][data-city="DPS"] button[aria-label="One more night in Bali"]')!;
    const before = el.textContent;
    const t0 = performance.now();
    const done = new Promise<number>((resolve) => {
      const mo = new MutationObserver(() => {
        if (el.textContent !== before) {
          mo.disconnect();
          resolve(performance.now() - t0);
        }
      });
      mo.observe(el, { characterData: true, childList: true, subtree: true });
    });
    btn.click();
    return done;
  });
  console.log(`nights change on screen in ${Math.round(ms)} ms`);
  expect(ms).toBeLessThan(400);
  await card.getByRole("button", { name: "One fewer night in Bali" }).click();
  await expect(page.getByTestId("change-bar")).toBeVisible();
});
