import { z } from "zod";

/**
 * The trip inbox: booking confirmations, social links and notes sent to the
 * trip's email address (or pasted in), read into suggested bookings and
 * activity ideas.
 */

export const INBOX_KINDS = ["leg", "stay", "activity", "unknown"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const INBOX_STATUSES = ["applied", "pending", "dismissed", "failed"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export type InboxSource = "email" | "paste";

/** A ticket read from a confirmation. Times are local with an offset, like "2027-05-19T08:05+08:00". */
export interface LegSuggestion {
  kind: "leg";
  mode: "flight" | "hsr" | "train" | "road" | "boat";
  status: "booked" | "held";
  fromCityCode: string | null;
  toCityCode: string | null;
  fromName: string | null;
  toName: string | null;
  /** IATA airport codes for flights. */
  fromAirport: string | null;
  toAirport: string | null;
  operator: string | null;
  number: string | null;
  departAt: string | null;
  arriveAt: string | null;
  /** CAD per person, converted when the email is in another currency. */
  pricePerPersonCad: number | null;
  /** Only shown to editors and the owner. */
  bookingRef: string | null;
  seat: string | null;
}

export interface StaySuggestion {
  kind: "stay";
  status: "booked" | "chosen";
  hotelName: string;
  cityCode: string | null;
  areaName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  rooms: number | null;
  /** CAD per room per night. */
  perNightCad: number | null;
  url: string | null;
  bookingRef: string | null;
}

export interface ActivitySuggestion {
  kind: "activity";
  title: string;
  cityCode: string | null;
  url: string | null;
  tags: string[];
  costCad: number | null;
  note: string | null;
  thumbnailUrl: string | null;
}

export type InboxSuggestion = LegSuggestion | StaySuggestion | ActivitySuggestion;

export interface InboxItem {
  id: string;
  tripId: string;
  /** Items read from the same email share a message id. */
  messageId: string;
  source: InboxSource;
  from: string | null;
  fromName: string | null;
  subject: string | null;
  receivedAt: string;
  kind: InboxKind;
  status: InboxStatus;
  /** One line describing what was found, e.g. "Train G87 Beijing West → Xi'an North, May 19". */
  summary: string;
  suggestion: InboxSuggestion | null;
  /** The stop it was (or would be) added to. */
  stopId: string | null;
  stopLabel: string | null;
  /** What happened, or why it is waiting for someone. */
  note: string | null;
  appliedBy: string | null;
  appliedAt: string | null;
}

export interface InboxResult {
  items: InboxItem[];
  /** The trip's email address, when inbound email is set up on this deployment. */
  address: string | null;
  /** Whether Claude reads the items (otherwise only links are recognised). */
  reader: "claude" | "basic";
  canSeePrivate: boolean;
}

export const pasteBody = z.object({
  text: z.string().trim().min(1, "Paste something first").max(50_000),
  subject: z.string().trim().max(200).nullish(),
});
export type PasteBody = z.infer<typeof pasteBody>;

/** Accept a waiting item, optionally pointing it at a different stop or city. */
export const acceptBody = z.object({
  stopId: z.string().min(1).nullish(),
  cityCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullish(),
});
export type AcceptBody = z.infer<typeof acceptBody>;
