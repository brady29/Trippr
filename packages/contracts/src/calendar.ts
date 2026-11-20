import { z } from "zod";

/**
 * Calendar feeds: each member's private, subscribable link to the trip's
 * current route (GET /cal/<token>.ics).
 */

/** Create or rotate my feed. Booking references are for editors and the owner only. */
export const calendarFeedBody = z.object({
  includePrivate: z.boolean().optional(),
});
export type CalendarFeedBody = z.infer<typeof calendarFeedBody>;

/** Returned once, when the link is made; the token is never shown again. */
export interface CalendarFeedLink {
  /** https://…/cal/<token>.ics */
  url: string;
  /** The same link as webcal://, which calendar apps open as a subscription. */
  webcalUrl: string;
  /** Opens Google Calendar's "add by URL" with the feed filled in. */
  googleUrl: string;
  includePrivate: boolean;
}

/** Whether I have a feed for this trip (never the token). */
export interface CalendarFeedStatus {
  enabled: boolean;
  includePrivate: boolean;
  createdAt: string | null;
  /** Editors and the owner may include booking references. */
  canIncludePrivate: boolean;
}
