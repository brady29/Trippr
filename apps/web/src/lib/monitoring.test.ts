import type { ErrorEvent } from "@sentry/browser";
import { describe, expect, it } from "vitest";
import { scrubEvent, scrubUrl } from "./monitoring";

describe("error report scrubbing", () => {
  it("drops query strings and invite tokens from URLs", () => {
    expect(scrubUrl("https://trippr.app/invite/abc123?x=1")).toBe("https://trippr.app/invite/:token");
    expect(scrubUrl("https://trippr.app/trips/asia-2027/inbox#top")).toBe("https://trippr.app/trips/asia-2027/inbox");
  });

  it("keeps only the scrubbed URL of the request and drops users and breadcrumbs", () => {
    const event = scrubEvent({
      type: undefined,
      request: { url: "https://trippr.app/invite/secret-token", headers: { cookie: "session=1" }, data: "{}" },
      user: { email: "someone@example.com" },
      breadcrumbs: [{ message: "clicked" }],
    } as ErrorEvent);
    expect(event.request).toEqual({ url: "https://trippr.app/invite/:token" });
    expect(event.user).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
  });
});
