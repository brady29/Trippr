import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import type { LinkPreview } from "./links";

/** What a reader finds in one message: zero or more things worth adding to the trip. */
export const extractedSchema = z.object({
  items: z.array(
    z.object({
      kind: z.enum(["leg", "stay", "activity"]),
      summary: z.string(),
      leg: z
        .object({
          mode: z.enum(["flight", "hsr", "train", "road", "boat"]),
          status: z.enum(["booked", "held"]),
          fromCityCode: z.string().nullable(),
          toCityCode: z.string().nullable(),
          fromName: z.string().nullable(),
          toName: z.string().nullable(),
          fromAirport: z.string().nullable(),
          toAirport: z.string().nullable(),
          operator: z.string().nullable(),
          number: z.string().nullable(),
          departAt: z.string().nullable(),
          arriveAt: z.string().nullable(),
          pricePerPersonCad: z.number().nullable(),
          bookingRef: z.string().nullable(),
          seat: z.string().nullable(),
        })
        .nullable(),
      stay: z
        .object({
          status: z.enum(["booked", "chosen"]),
          hotelName: z.string(),
          cityCode: z.string().nullable(),
          areaName: z.string().nullable(),
          checkIn: z.string().nullable(),
          checkOut: z.string().nullable(),
          rooms: z.number().int().nullable(),
          perNightCad: z.number().nullable(),
          url: z.string().nullable(),
          bookingRef: z.string().nullable(),
        })
        .nullable(),
      activity: z
        .object({
          title: z.string(),
          cityCode: z.string().nullable(),
          url: z.string().nullable(),
          tags: z.array(z.string()),
          costCad: z.number().nullable(),
          note: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
});
export type Extracted = z.infer<typeof extractedSchema>;
export type ExtractedItem = Extracted["items"][number];

export interface ReaderCity {
  code: string;
  name: string;
  countryName: string;
}

export interface ReaderContext {
  cities: ReaderCity[];
  /** The current route's stops, in order. */
  stops: { code: string; name: string; arrive: string; depart: string }[];
  travellers: number;
  today: string;
}

export interface ReaderMessage {
  from: string | null;
  subject: string | null;
  text: string;
  links: LinkPreview[];
  /** PDF attachments (tickets, invoices) as base64. */
  pdfs: { name: string; base64: string }[];
}

export interface InboxReader {
  name: "claude" | "basic";
  read(message: ReaderMessage, ctx: ReaderContext): Promise<Extracted>;
}

export class ReaderError extends Error {}

/** Longest message body sent to the reader; longer emails are cut and the item says so. */
export const MAX_BODY_CHARS = 60_000;

const SYSTEM = `You read messages that members of a group trip send to the trip's shared inbox: booking confirmations (flights, trains, buses, ferries, hotels), social media posts and videos about places, and plain notes. Pull out every ticket, hotel stay and activity idea that belongs in the trip plan.

Tickets
- One item per leg: one flight or one train segment. A connection is several legs; a return trip is two legs.
- mode: flight, hsr (high-speed rail such as Shinkansen, KTX or Chinese G/D trains), train (other rail), road (bus, van, car transfer) or boat.
- fromAirport and toAirport: IATA airport codes for flights, otherwise null. fromName and toName: the airport or station names as written.
- departAt and arriveAt: local time at that place with its UTC offset, like 2027-05-19T08:05+08:00. Null when the time is not stated.
- pricePerPersonCad: the fare per traveller in Canadian dollars. Divide a group total by the number of passengers on the booking. Convert other currencies at a recent approximate rate.
- status: booked when a purchase is confirmed or ticketed; held for holds and unpaid reservations.
- bookingRef: the confirmation, booking or PNR code. seat: the seat or berth, if given.

Hotels
- One item per stay. checkIn and checkOut as YYYY-MM-DD. perNightCad: price per room per night in Canadian dollars (divide the total by nights and rooms when only a total is given).
- areaName: the neighbourhood or district the hotel is in, if the message or your knowledge of the hotel makes it clear; otherwise null.
- status: booked when the reservation is confirmed, otherwise chosen.

Activities
- From social posts, link previews and notes that name a specific thing to do, see or eat. One item per place.
- title: the place or experience in plain words, not the caption ("Shibuya Sky", "Hotpot at Xiaolongkan"). url: the link it came from.
- tags: one to three short lowercase words such as food, view, museum, nightlife, nature, shopping, temple.
- note: one sentence on why it is worth going, drawn from the post. costCad when a price is stated.

Everywhere
- City codes (fromCityCode, toCityCode, cityCode) must be codes from the city list in the trip context, or null when the place is not in it.
- Use only what the message says, plus well-known facts needed to place it (which city an airport or landmark is in). Do not invent times, prices or references.
- Ignore marketing, upsells, loyalty offers, footers and unrelated links.
- summary: one short line, like "Flight AC 1 Toronto → Tokyo Haneda, May 9" or "Shibuya Sky, Tokyo (from TikTok)".
- Return an empty list when nothing in the message belongs in the trip plan.`;

function contextBlock(ctx: ReaderContext): string {
  const stops = ctx.stops.map((s, i) => `${i + 1}. ${s.code} ${s.name}: ${s.arrive} to ${s.depart}`).join("\n");
  return `Today is ${ctx.today}. The group has ${ctx.travellers} traveller${ctx.travellers === 1 ? "" : "s"}.

Current route:
${stops || "(no stops yet)"}`;
}

function messageBlock(m: ReaderMessage): string {
  const links = m.links
    .map((l) => `- ${l.url}${l.title ? `\n  title: ${l.title}` : ""}${l.author ? `\n  by: ${l.author}` : ""}`)
    .join("\n");
  return `From: ${m.from ?? "unknown"}
Subject: ${m.subject ?? "(none)"}

${m.text.slice(0, MAX_BODY_CHARS)}${links ? `\n\nLinks found in the message:\n${links}` : ""}`;
}

export function createClaudeReader(options: { apiKey: string; model: string }): InboxReader {
  const client = new Anthropic({ apiKey: options.apiKey, timeout: 90_000, maxRetries: 1 });
  return {
    name: "claude",
    async read(message, ctx) {
      const cityList = ctx.cities.map((c) => `${c.code} ${c.name} (${c.countryName})`).join("\n");
      const content: Anthropic.Beta.BetaContentBlockParam[] = [
        ...message.pdfs.map(
          (pdf): Anthropic.Beta.BetaContentBlockParam => ({
            type: "document",
            title: pdf.name,
            source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
          }),
        ),
        { type: "text", text: `${contextBlock(ctx)}\n\nMessage:\n${messageBlock(message)}` },
      ];
      const response = await client.beta.messages.parse({
        model: options.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [
          { type: "text", text: SYSTEM },
          // The city list changes rarely, so it is cached along with the instructions.
          { type: "text", text: `City list (code, name, country):\n${cityList}`, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content }],
        output_config: { format: betaZodOutputFormat(extractedSchema) },
      });
      if (response.stop_reason === "refusal") throw new ReaderError("Claude declined to read this message.");
      if (response.stop_reason === "max_tokens") throw new ReaderError("The message was too long to read in one go.");
      if (!response.parsed_output) throw new ReaderError("Claude's answer couldn't be read.");
      return response.parsed_output;
    },
  };
}

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** The first city named in the text, preferring cities on the route. */
export function findCity(text: string, ctx: ReaderContext): ReaderCity | null {
  const hay = norm(text);
  const onRoute = new Set(ctx.stops.map((s) => s.code));
  const named = (c: ReaderCity) => new RegExp(`(^|[^a-z])${norm(c.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z])`).test(hay);
  const ordered = [...ctx.cities].sort((a, b) => Number(onRoute.has(b.code)) - Number(onRoute.has(a.code)) || b.name.length - a.name.length);
  return ordered.find(named) ?? null;
}

const cleanTitle = (s: string) =>
  s
    .replace(/#[\p{L}\p{N}_]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

/**
 * Without an API key: each social or plain link becomes an activity idea,
 * placed in the first city the message names. Bookings are left for a person.
 */
export const basicReader: InboxReader = {
  name: "basic",
  async read(message, ctx) {
    const items: ExtractedItem[] = [];
    for (const link of message.links) {
      const words = [link.title, message.subject, message.text].filter(Boolean).join("\n");
      const city = findCity(words, ctx);
      const firstLine = message.text
        .replace(/https?:\/\/\S+/g, "")
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean);
      const title = cleanTitle(link.title ?? message.subject ?? firstLine ?? "") || `Idea from ${link.host}`;
      items.push({
        kind: "activity",
        summary: `${title}${city ? `, ${city.name}` : ""}${link.social ? ` (from ${link.host})` : ""}`,
        leg: null,
        stay: null,
        activity: {
          title,
          cityCode: city?.code ?? null,
          url: link.url,
          tags: link.social ? ["social"] : [],
          costCad: null,
          note: link.author ? `Posted by ${link.author}.` : null,
        },
      });
    }
    return { items };
  },
};
