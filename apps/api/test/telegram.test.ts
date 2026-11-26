import type { InboxResult, TelegramStatus } from "@trippr/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Extracted, InboxReader } from "../src/services/inbox/reader";
import { parseCommand, replyFor } from "../src/services/telegram/bot";
import type { TelegramApi } from "../src/services/telegram/api";
import { client, signIn, startHarness, type Harness } from "./harness";

const TRIP = "asia-2027";
const SECRET = "telegram-secret-0123456789";
const BOT = "trippr_test_bot";

/** Stands in for Claude: returns whatever the test queues next. */
let next: Extracted = { items: [] };
let reads = 0;
const fakeReader: InboxReader = {
  name: "claude",
  async read() {
    reads++;
    return next;
  },
};

/** Records what the bot says instead of calling Telegram. */
const sent: { chatId: string; text: string }[] = [];
const fakeTelegram: TelegramApi = {
  async sendMessage(chatId, text) {
    sent.push({ chatId, text });
  },
  async setWebhook() {},
};

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let editor: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;
let updateId = 1000;

const idea = (title: string) => ({
  kind: "activity" as const,
  summary: `${title}, Tokyo (from Instagram)`,
  leg: null,
  stay: null,
  activity: { title, cityCode: "TYO", url: "https://www.instagram.com/reel/abc/", tags: [], costCad: null, note: null },
});

/** One Telegram update from a person in a chat. */
function message(chatId: number, text: string, opts: { group?: boolean; from?: string; isBot?: boolean } = {}) {
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      chat: opts.group ? { id: chatId, type: "supergroup", title: "Asia crew" } : { id: chatId, type: "private", first_name: "Sam" },
      from: { id: 42, is_bot: opts.isBot ?? false, first_name: opts.from ?? "Sam", username: "sam_t" },
      text,
    },
  };
}

const hook = (body: unknown, secret: string | null = SECRET) =>
  h.app.inject({ method: "POST", url: "/telegram/webhook", payload: body as object, headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {} });

const lastReply = (chatId: number) => sent.filter((s) => s.chatId === String(chatId)).at(-1)?.text ?? "";

beforeAll(async () => {
  h = await startHarness({
    inboxReader: fakeReader,
    telegramApi: fakeTelegram,
    env: { TELEGRAM_BOT_TOKEN: "123456:test-token-not-real-0000", TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: BOT, PUBLIC_WEB_URL: "https://trippr.test" },
  });
  owner = await signIn(h.app, "Telegram Owner");
  editor = await signIn(h.app, "Telegram Editor");
  viewer = await signIn(h.app, "Telegram Viewer");
  await owner.api.post(`/invites/${h.ownerInvite}/accept`);
  for (const [who, role] of [
    [editor, "editor"],
    [viewer, "viewer"],
  ] as const) {
    const invite = await owner.api.post(`/trips/${TRIP}/invites`, { role });
    await who.api.post(`/invites/${invite.body.token}/accept`);
  }
});

afterAll(async () => {
  await h?.close();
});

beforeEach(() => {
  next = { items: [] };
});

describe("the Telegram bot", () => {
  it("gives each editor a link code and deep links, and keeps viewers out", async () => {
    const status = (await owner.api.get<TelegramStatus>(`/trips/${TRIP}/telegram`)).body;
    expect(status).toMatchObject({ enabled: true, botUsername: BOT, chats: [] });
    expect(status.code).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(status.groupLink).toBe(`https://t.me/${BOT}?startgroup=${status.code}`);
    expect(status.directLink).toBe(`https://t.me/${BOT}?start=${status.code}`);
    // The same code until it's replaced.
    expect((await owner.api.get<TelegramStatus>(`/trips/${TRIP}/telegram`)).body.code).toBe(status.code);
    const fresh = (await owner.api.post<TelegramStatus>(`/trips/${TRIP}/telegram/code`)).body;
    expect(fresh.code).not.toBe(status.code);
    expect((await viewer.api.get(`/trips/${TRIP}/telegram`)).status).toBe(403);
  });

  it("refuses calls without the webhook secret", async () => {
    expect((await hook(message(1, "hi"), null)).statusCode).toBe(403);
    expect((await hook(message(1, "hi"), "wrong-secret-0123456789")).statusCode).toBe(403);
  });

  it("links a group with /start <code>, then turns a shared reel into an idea and says so", async () => {
    const code = (await owner.api.get<TelegramStatus>(`/trips/${TRIP}/telegram`)).body.code!;
    expect((await hook(message(-1001, `/start@${BOT} ${code}`, { group: true }))).statusCode).toBe(200);
    expect(lastReply(-1001)).toContain("Linked to Asia 2027");
    const status = (await owner.api.get<TelegramStatus>(`/trips/${TRIP}/telegram`)).body;
    expect(status.chats).toEqual([expect.objectContaining({ chatId: "-1001", title: "Asia crew", kind: "group", linkedBy: "Telegram Owner" })]);

    next = { items: [idea("Shibuya Sky at sunset")] };
    await hook(message(-1001, "omg we have to https://www.instagram.com/reel/abc/", { group: true, from: "Riley" }));
    expect(lastReply(-1001)).toMatch(/^Added: /);
    expect(lastReply(-1001)).toContain("https://trippr.test/trips/asia-2027/inbox");
    const inbox = (await owner.api.get<InboxResult>(`/trips/${TRIP}/inbox`)).body;
    expect(inbox.items[0]).toMatchObject({ source: "telegram", status: "applied", fromName: "Riley", from: "@sam_t" });
  });

  it("ignores group chatter without a link, bots, and repeated updates", async () => {
    const before = reads;
    await hook(message(-1001, "lol same", { group: true }));
    await hook(message(-1001, "https://www.instagram.com/reel/xyz/", { group: true, isBot: true }));
    expect(reads).toBe(before);

    next = { items: [idea("teamLab Planets")] };
    const repeat = message(-1001, "https://www.instagram.com/reel/again/", { group: true });
    await hook(repeat);
    await hook(repeat);
    expect(reads).toBe(before + 1);
  });

  it("answers /trip and /top, and /unlink stops the chat", async () => {
    await hook(message(-1001, "/trip", { group: true }));
    expect(lastReply(-1001)).toContain("This chat feeds Asia 2027, linked by Telegram Owner");
    await hook(message(-1001, "/top", { group: true }));
    expect(lastReply(-1001)).toMatch(/favourites|No favourites yet/);
    await hook(message(-1001, "/unlink", { group: true }));
    expect(lastReply(-1001)).toContain("no longer sends to Asia 2027");
    expect((await owner.api.get<TelegramStatus>(`/trips/${TRIP}/telegram`)).body.chats).toEqual([]);
  });

  it("tells an unlinked direct chat how to link, and rejects a bad code", async () => {
    await hook(message(77, "https://www.instagram.com/reel/abc/"));
    expect(lastReply(77)).toContain("isn't linked to a trip yet");
    await hook(message(77, "/start not-a-real-code"));
    expect(lastReply(77)).toContain("That code didn't work");
  });

  it("holds items for an editor when the person who linked the chat is now a viewer", async () => {
    const code = (await editor.api.get<TelegramStatus>(`/trips/${TRIP}/telegram`)).body.code!;
    await hook(message(88, `/start ${code}`));
    expect(lastReply(88)).toContain("Linked to Asia 2027");
    expect((await owner.api.put(`/trips/${TRIP}/members/${editor.id}`, { role: "viewer" })).status).toBe(200);
    next = { items: [idea("Golden Gai bar crawl")] };
    await hook(message(88, "https://www.instagram.com/reel/golden/"));
    expect(lastReply(88)).toContain("In the Inbox to check");
    // An owner can unlink it from Trippr.
    const unlinked = await owner.api.del<TelegramStatus>(`/trips/${TRIP}/telegram/chats/88`);
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.chats).toEqual([]);
  });
});

describe("with no bot token", () => {
  it("is off: the webhook is missing and the panel says so", async () => {
    const plain = await startHarness();
    try {
      const me = await signIn(plain.app, "Plain Owner");
      await me.api.post(`/invites/${plain.ownerInvite}/accept`);
      expect((await me.api.get<TelegramStatus>(`/trips/${TRIP}/telegram`)).body).toMatchObject({ enabled: false, code: null, groupLink: null });
      expect((await client(plain.app).post("/telegram/webhook", { update_id: 1 })).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe("bot helpers", () => {
  it("reads commands meant for this bot only", () => {
    expect(parseCommand("/start abc123", BOT)).toEqual({ name: "start", arg: "abc123" });
    expect(parseCommand(`/top@${BOT}`, BOT)).toEqual({ name: "top", arg: "" });
    expect(parseCommand("/top@someone_else_bot", BOT)).toBeNull();
    expect(parseCommand("not a command", BOT)).toBeNull();
  });

  it("sums up what happened to each item", () => {
    expect(replyFor([], "https://x/inbox")).toBe("Saved to the Inbox. https://x/inbox");
  });
});
