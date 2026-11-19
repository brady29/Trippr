import { timingSafeEqual } from "node:crypto";
import { acceptBody, pasteBody, type InboxItem, type InboxResult } from "@trippr/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { forbidden, notFound } from "../errors";
import { newToken } from "../ids";

const idParams = z.object({ id: z.string().min(1) });

/** The fields of Postmark's inbound webhook that Trippr uses; everything else is ignored. */
const postmarkInbound = z
  .object({
    From: z.string().optional(),
    FromName: z.string().optional(),
    FromFull: z.object({ Email: z.string().optional(), Name: z.string().optional() }).partial().optional(),
    To: z.string().optional(),
    ToFull: z.array(z.object({ Email: z.string().optional(), MailboxHash: z.string().optional() }).partial()).optional(),
    MailboxHash: z.string().optional(),
    Subject: z.string().optional(),
    TextBody: z.string().optional(),
    HtmlBody: z.string().optional(),
    Headers: z.array(z.object({ Name: z.string(), Value: z.string() })).optional(),
    Attachments: z
      .array(z.object({ Name: z.string().optional(), Content: z.string().optional(), ContentType: z.string().optional(), ContentLength: z.number().optional() }))
      .optional(),
  })
  .passthrough();

/** Keep booking references to the people allowed to see them. */
function redact(item: InboxItem, canSeePrivate: boolean): InboxItem {
  if (canSeePrivate || !item.suggestion || item.suggestion.kind === "activity") return item;
  const suggestion = item.suggestion.kind === "leg" ? { ...item.suggestion, bookingRef: null, seat: null } : { ...item.suggestion, bookingRef: null };
  return { ...item, suggestion };
}

function secretMatches(req: FastifyRequest, secret: string): boolean {
  const query = (req.query as Record<string, unknown>)?.secret;
  let given = typeof query === "string" ? query : "";
  const header = req.headers.authorization;
  if (!given && header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    given = decoded.slice(decoded.indexOf(":") + 1);
  }
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** SPF or DKIM passed for the sender's domain, per the headers the email service adds. */
function senderAuthenticated(headers: { Name: string; Value: string }[] = []): boolean {
  return headers.some(
    (h) =>
      (/^received-spf$/i.test(h.Name) && /^\s*pass\b/i.test(h.Value)) ||
      (/^authentication-results$/i.test(h.Name) && /\b(dkim|spf)=pass\b/i.test(h.Value)),
  );
}

export function inboxRoutes(app: FastifyInstance, ctx: AppContext) {
  const { repos, guards, config } = ctx;

  const addressFor = (token: string | null) => {
    const base = config.INBOX_EMAIL_ADDRESS;
    if (!base || !token) return null;
    const [local, domain] = base.split("@");
    return `${local}+${token}@${domain}`;
  };

  async function ensureToken(tripId: string) {
    return (await repos.inbox.getToken(tripId)) ?? (await repos.inbox.setToken(tripId, newToken()));
  }

  /** The trip's inbox: what was read from each message and what happened to it. Editors only. */
  app.get("/trips/:id/inbox", async (req): Promise<InboxResult> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "editor");
    const canSeePrivate = !user.isDemo;
    const items = await repos.inbox.list(id);
    return {
      items: items.map((i) => redact(i, canSeePrivate)),
      address: config.INBOX_EMAIL_ADDRESS ? addressFor(await ensureToken(id)) : null,
      reader: ctx.inboxReader.name,
      canSeePrivate,
    };
  });

  /** Paste a confirmation, a link or a note instead of emailing it. */
  app.post("/trips/:id/inbox", { bodyLimit: 256 * 1024 }, async (req, reply): Promise<InboxItem[]> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role } = await guards.trip(user, id, "editor");
    const body = ctx.parse(pasteBody, req.body);
    const items = await ctx.inbox.receive({
      tripId: id,
      source: "paste",
      from: user.email ?? null,
      fromName: user.name ?? null,
      subject: body.subject ?? null,
      text: body.text,
      sender: { id: user.id, name: user.name ?? null, role },
      trusted: true,
    });
    reply.status(201);
    return items;
  });

  /** A new address for the trip; the old one stops working. Owner only. */
  app.post("/trips/:id/inbox/address", async (req): Promise<{ address: string | null }> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "owner");
    return { address: addressFor(await repos.inbox.setToken(id, newToken())) };
  });

  async function itemFor(req: FastifyRequest) {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const item = await repos.inbox.get(id);
    if (!item) throw notFound("Inbox item");
    await guards.trip(user, item.tripId, "editor");
    return { user, item };
  }

  app.post("/inbox/:id/accept", async (req): Promise<InboxItem> => {
    const { user, item } = await itemFor(req);
    const body = ctx.parse(acceptBody, req.body);
    return ctx.inbox.apply(item.id, { id: user.id, name: user.name ?? null }, body);
  });

  app.post("/inbox/:id/dismiss", async (req): Promise<InboxItem> => {
    const { user, item } = await itemFor(req);
    return ctx.inbox.dismiss(item.id, user.id);
  });

  /**
   * Postmark's inbound webhook. The trip is found from the secret after the
   * "+" in the address it was sent to; anything else is accepted and dropped
   * so the address can't be probed.
   */
  app.post("/inbound/postmark", { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const secret = config.INBOX_WEBHOOK_SECRET;
    if (!secret) throw notFound("Inbound email");
    if (!secretMatches(req, secret)) throw forbidden("Bad webhook secret");
    const mail = postmarkInbound.parse(req.body ?? {});
    const token = mail.MailboxHash || mail.ToFull?.find((t) => t.MailboxHash)?.MailboxHash || "";
    const tripId = token ? await repos.inbox.tripByToken(token) : null;
    if (!tripId) {
      req.log.info("inbound email for an unknown trip address");
      return reply.status(200).send({ ok: true });
    }
    const fromEmail = mail.FromFull?.Email ?? mail.From ?? null;
    const member = fromEmail ? await repos.inbox.memberByEmail(tripId, fromEmail) : null;
    const pdfs =
      ctx.inboxReader.name === "claude"
        ? (mail.Attachments ?? [])
            .filter((a) => a.ContentType === "application/pdf" && a.Content && (a.ContentLength ?? a.Content.length) <= 4_000_000)
            .slice(0, 2)
            .map((a) => ({ name: a.Name ?? "attachment.pdf", base64: a.Content! }))
        : [];
    await ctx.inbox.receive({
      tripId,
      source: "email",
      from: fromEmail,
      fromName: mail.FromFull?.Name ?? mail.FromName ?? null,
      subject: mail.Subject ?? null,
      text: mail.TextBody ?? "",
      html: mail.HtmlBody ?? null,
      pdfs,
      sender: member ? { id: member.id, name: member.name, role: member.role } : null,
      trusted: senderAuthenticated(mail.Headers),
    });
    return { ok: true };
  });
}
