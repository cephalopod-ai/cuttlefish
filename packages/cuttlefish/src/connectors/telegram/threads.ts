import type { ReplyContext } from "../../shared/types.js";

export interface TelegramMessageLike {
  chat: { id: number; type: string };
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  date?: number;
}

/**
 * Derive a session key from a Telegram message.
 * Format: telegram:<chatId>
 */
export function deriveSessionKey(msg: TelegramMessageLike): string {
  return `telegram:${msg.chat.id}`;
}

/**
 * Build a reply context from a Telegram message.
 */
export function buildReplyContext(msg: TelegramMessageLike): ReplyContext {
  return {
    chatId: msg.chat.id,
    messageId: msg.message_id,
  };
}

/**
 * Check if a Telegram message predates the gateway boot time.
 * Telegram dates are Unix timestamps in seconds; bootTimeMs is in milliseconds.
 */
export function isOldTelegramMessage(
  date: number | undefined,
  bootTimeMs: number,
): boolean {
  if (date === undefined) return false;
  return date * 1000 < bootTimeMs;
}
