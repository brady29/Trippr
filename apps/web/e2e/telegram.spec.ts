import { expect, test } from "@playwright/test";
import { E2E_API_URL, E2E_OWNER_INVITE } from "../playwright.config";

/** The e2e server has no bot token, so the Inbox shows how the bot will work once it's set up. */
let token = "";

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${E2E_API_URL}/auth/dev-login`, { data: { name: "E2E Owner" } });
  token = (await login.json()).token;
  const accept = await request.post(`${E2E_API_URL}/invites/${E2E_OWNER_INVITE}/accept`, { headers: { authorization: `Bearer ${token}` } });
  expect([200, 404]).toContain(accept.status());
});

test("the Inbox explains the Telegram bot when it isn't set up yet", async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem("trippr.token", t), token);
  await page.goto("/trips/asia-2027/inbox");
  const panel = page.getByTestId("telegram-panel");
  await expect(panel).toContainText("Share from Telegram");
  await expect(panel.getByTestId("telegram-off")).toContainText("isn't set up on this server yet");
});
