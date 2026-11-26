/**
 * The Telegram bot: a group chat (or a direct chat with the bot) linked to a
 * trip. Shared reels and links land in the trip's Inbox.
 */
export interface TelegramChatLink {
  chatId: string;
  /** The group's title, or the person's name for a direct chat. */
  title: string | null;
  kind: "private" | "group";
  linkedAt: string;
  linkedBy: string | null;
}

export interface TelegramStatus {
  /** False until the bot's token is set on this server; the panel then says how to set it up. */
  enabled: boolean;
  botUsername: string | null;
  /** The current member's link code for this trip (editors and owners only). */
  code: string | null;
  /** Opens Telegram to add the bot to a group with the code, or to start a direct chat with it. */
  groupLink: string | null;
  directLink: string | null;
  chats: TelegramChatLink[];
}
