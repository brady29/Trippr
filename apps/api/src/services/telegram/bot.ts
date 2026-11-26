import { activityPageQuery, hasRole, type InboxItem } from "@trippr/contracts";
import type { AppContext } from "../../app";
import type { TelegramApi } from "./api";

/** The parts of a Telegram update Trippr reads; everything else is ignored. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string; type: "private" | "group" | "supergroup" | "channel"; title?: string; first_name?: string; last_name?: string };
    from?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
    text?: string;
    caption?: string;
    entities?: { type: string; offset: number; length: number }[];
    caption_entities?: { type: string; offset: number; length: number }[];
  };
}

const HELP = [
  "Share reels, TikToks, Google Maps links or notes here and they go straight into your Trippr trip's Inbox.",
  "In a group I only read messages with a link, a command, or ones that mention me.",
  "/trip which trip this chat feeds · /top the group's favourite ideas · /unlink stop sending here",
].join("\n");

const NOT_LINKED = "This chat isn't linked to a trip yet. In Trippr, open your trip's Inbox → Telegram and use \"Add to a group\" or send me the code it shows: /start <code>";

/** "/start abc", "/start@trippr_bot abc" → { name: "start", arg: "abc" }; only commands meant for this bot. */
export function parseCommand(text: string, botUsername: string | null): { name: string; arg: string } | null {
  const m = /^\/([a-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$/s.exec(text.trim());
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name: m[1]!.toLowerCase(), arg: (m[3] ?? "").trim() };
}

const hasLink = (text: string) => /\bhttps?:\/\/\S+/i.test(text) || /\b(?:www\.|maps\.app\.goo\.gl|vm\.tiktok\.com|instagram\.com|youtu\.be)\S*/i.test(text);

/** Up to 30 messages a minute per chat, so a busy group can't run up the reader's bill. */
function rateLimiter(perMinute = 30) {
  const hits = new Map<string, number[]>();
  return (chatId: string, now = Date.now()) => {
    const recent = (hits.get(chatId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) {
      hits.set(chatId, recent);
      return false;
    }
    recent.push(now);
    hits.set(chatId, recent);
    return true;
  };
}

/** What happened to each item, in a line each, for the reply in the chat. */
export function replyFor(items: InboxItem[], inboxUrl: string): string {
  if (!items.length) return `Saved to the Inbox. ${inboxUrl}`;
  const lines = items.slice(0, 3).map((i) =>
    i.status === "applied" ? `Added: ${i.note ?? i.summary}` : i.status === "failed" ? `Couldn't add ${i.summary}: ${i.note ?? "try it in the Inbox"}` : `In the Inbox to check: ${i.summary}${i.note ? ` (${i.note})` : ""}`,
  );
  if (items.length > 3) lines.push(`…and ${items.length - 3} more.`);
  return `${lines.join("\n")}\n${inboxUrl}`;
}

export function createTelegramBot(ctx: AppContext, api: TelegramApi) {
  const { repos, config } = ctx;
  const allow = rateLimiter();
  const web = config.PUBLIC_WEB_URL.replace(/\/$/, "");
  const say = (chatId: string, text: string, replyTo?: number) =>
    api.sendMessage(chatId, text, { replyTo }).catch((e) => ctx.log.warn({ err: String(e) }, "telegram reply failed"));

  async function topIdeas(tripId: string, userId: string | null): Promise<string> {
    if (!userId) return "Nobody on the trip has voted yet.";
    const page = await repos.activities.page(tripId, userId, activityPageQuery.parse({ scope: "mine", limit: 5 }));
    const voted = page.items.filter((a) => a.votes > 0);
    if (!voted.length) return `No favourites yet. Swipe some ideas: ${web}/trips/${tripId}/swipe`;
    return [
      "The group's favourites so far:",
      ...voted.map((a, i) => `${i + 1}. ${a.title} (${a.cityName}) · ${a.ups ?? a.votes} yes`),
      `Swipe more: ${web}/trips/${tripId}/swipe`,
    ].join("\n");
  }

  async function handle(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || msg.from?.is_bot || msg.chat.type === "channel") return;
    const chatId = String(msg.chat.id);
    const group = msg.chat.type !== "private";
    const text = (msg.text ?? msg.caption ?? "").trim();
    if (!text) return;
    const cmd = parseCommand(text, config.TELEGRAM_BOT_USERNAME ?? null);

    if (cmd?.name === "start" && cmd.arg) {
      const owner = await repos.telegram.byCode(cmd.arg);
      if (!owner?.userId || !owner.role || !hasRole(owner.role, "editor")) {
        return say(chatId, "That code didn't work. Make a new one in Trippr: your trip's Inbox → Telegram.", msg.message_id);
      }
      const title = msg.chat.title ?? [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") ?? null;
      await repos.telegram.link(chatId, owner.tripId, owner.userId, title || null, group ? "group" : "private");
      ctx.notify(owner.tripId, { kind: "inbox" }, owner.userId);
      return say(chatId, `Linked to ${owner.tripName}. Share reels, TikToks and links here and they land in the trip's Inbox.\n${HELP}`, msg.message_id);
    }

    const link = await repos.telegram.chat(chatId);
    if (!link) {
      // Quiet in groups unless spoken to, so a stray add doesn't spam the chat.
      if (!group || cmd) await say(chatId, NOT_LINKED, msg.message_id);
      return;
    }

    if (cmd) {
      if (cmd.name === "help" || cmd.name === "start") return say(chatId, HELP, msg.message_id);
      if (cmd.name === "trip") return say(chatId, `This chat feeds ${link.tripName}${link.userName ? `, linked by ${link.userName}` : ""}.\n${web}/trips/${link.tripId}`, msg.message_id);
      if (cmd.name === "top") return say(chatId, await topIdeas(link.tripId, link.userId), msg.message_id);
      if (cmd.name === "unlink") {
        await repos.telegram.unlink(chatId, null);
        ctx.notify(link.tripId, { kind: "inbox" }, link.userId ?? "telegram");
        return say(chatId, `Done. This chat no longer sends to ${link.tripName}.`, msg.message_id);
      }
      return say(chatId, HELP, msg.message_id);
    }

    const mentioned = config.TELEGRAM_BOT_USERNAME ? text.toLowerCase().includes(`@${config.TELEGRAM_BOT_USERNAME.toLowerCase()}`) : false;
    if (group && !hasLink(text) && !mentioned) return;
    if (!allow(chatId)) return say(chatId, "That's a lot at once. I'll take more in a minute.", msg.message_id);

    const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || null;
    const items = await ctx.inbox.receive({
      tripId: link.tripId,
      source: "telegram",
      from: msg.from?.username ? `@${msg.from.username}` : null,
      fromName: name,
      subject: null,
      text: config.TELEGRAM_BOT_USERNAME ? text.replace(new RegExp(`@${config.TELEGRAM_BOT_USERNAME}\\b`, "gi"), "").trim() : text,
      // Applied as the member who linked the chat; if they're a viewer (or left), items wait for an editor.
      sender: link.userId ? { id: link.userId, name: link.userName, role: link.role } : null,
      trusted: Boolean(link.role),
    });
    await say(chatId, replyFor(items, `${web}/trips/${link.tripId}/inbox`), msg.message_id);
  }

  return { handle };
}

export type TelegramBot = ReturnType<typeof createTelegramBot>;
