/**
 * The two Telegram Bot API calls Trippr makes. The token is only ever in the
 * request URL to Telegram; it is never logged.
 */
export interface TelegramApi {
  sendMessage(chatId: string, text: string, options?: { replyTo?: number }): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
}

export function createTelegramApi(token: string, base = "https://api.telegram.org", fetchImpl: typeof fetch = fetch): TelegramApi {
  async function call(method: string, body: Record<string, unknown>) {
    const res = await fetchImpl(`${base.replace(/\/$/, "")}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!res.ok || !json?.ok) throw new Error(`Telegram ${method} failed: ${json?.description ?? res.status}`);
  }
  return {
    sendMessage: (chatId, text, options = {}) =>
      call("sendMessage", {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(options.replyTo ? { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } } : {}),
      }),
    setWebhook: (url, secret) => call("setWebhook", { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false }),
  };
}
