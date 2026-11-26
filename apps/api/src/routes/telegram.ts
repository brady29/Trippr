import { timingSafeEqual } from "node:crypto";
import type { TelegramStatus } from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { forbidden, notFound } from "../errors";
import { newToken } from "../ids";
import type { TelegramBot, TelegramUpdate } from "../services/telegram/bot";

const idParams = z.object({ id: z.string().min(1) });
const chatParams = z.object({ id: z.string().min(1), chatId: z.string().min(1).max(40) });

const update = z
  .object({
    update_id: z.number().int(),
    message: z
      .object({
        message_id: z.number().int(),
        chat: z.object({ id: z.union([z.number(), z.string()]), type: z.enum(["private", "group", "supergroup", "channel"]) }).passthrough(),
        from: z.object({ id: z.number(), is_bot: z.boolean().optional() }).passthrough().optional(),
        text: z.string().max(8000).optional(),
        caption: z.string().max(4000).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function sameSecret(given: string | undefined, secret: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function telegramRoutes(app: FastifyInstance, ctx: AppContext, bot: TelegramBot | null) {
  const { repos, guards, config } = ctx;
  const username = config.TELEGRAM_BOT_USERNAME ?? null;

  const status = async (tripId: string, userId: string, canLink: boolean): Promise<TelegramStatus> => {
    const code = canLink && bot ? ((await repos.telegram.code(tripId, userId)) ?? (await repos.telegram.setCode(tripId, userId, newToken().slice(0, 16)))) : null;
    return {
      enabled: bot !== null,
      botUsername: username,
      code,
      groupLink: bot && username && code ? `https://t.me/${username}?startgroup=${code}` : null,
      directLink: bot && username && code ? `https://t.me/${username}?start=${code}` : null,
      chats: await repos.telegram.list(tripId),
    };
  };

  /** The Inbox's Telegram panel: whether the bot is on, this member's link code, and the linked chats. */
  app.get("/trips/:id/telegram", async (req): Promise<TelegramStatus> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "editor");
    return status(id, user.id, !user.isDemo);
  });

  /** A new link code; the old one stops working (chats already linked stay linked). */
  app.post("/trips/:id/telegram/code", async (req): Promise<TelegramStatus> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "editor");
    if (!bot) throw notFound("Telegram bot");
    await repos.telegram.setCode(id, user.id, newToken().slice(0, 16));
    return status(id, user.id, true);
  });

  app.delete("/trips/:id/telegram/chats/:chatId", async (req): Promise<TelegramStatus> => {
    const user = ctx.user(req);
    const { id, chatId } = ctx.parse(chatParams, req.params);
    await guards.trip(user, id, "editor");
    if (!(await repos.telegram.unlink(chatId, id))) throw notFound("Linked chat");
    ctx.notify(id, { kind: "inbox" }, user.id);
    return status(id, user.id, !user.isDemo);
  });

  /**
   * Telegram's webhook. Only calls carrying the secret are read; each update
   * is handled once, and the answer is always 200 so Telegram doesn't retry
   * something that failed on our side.
   */
  app.post("/telegram/webhook", { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const secret = config.TELEGRAM_WEBHOOK_SECRET;
    if (!bot || !secret) throw notFound("Telegram bot");
    const given = req.headers["x-telegram-bot-api-secret-token"];
    if (!sameSecret(typeof given === "string" ? given : undefined, secret)) throw forbidden("Bad webhook secret");
    const parsed = update.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(200).send({ ok: true });
    if (!(await repos.telegram.fresh(parsed.data.update_id))) return reply.status(200).send({ ok: true });
    try {
      await bot.handle(parsed.data as TelegramUpdate);
    } catch (e) {
      req.log.error({ err: e }, "telegram update failed");
    }
    return reply.status(200).send({ ok: true });
  });
}
