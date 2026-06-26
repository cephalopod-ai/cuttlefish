import { convertOutsideCode, formatAndChunk } from "../shared/format.js";

const WA_MAX_LENGTH = 4000;

/**
 * Convert standard markdown to WhatsApp formatting.
 * WhatsApp supports *bold*, _italic_, ~strikethrough~, ```code```, `code`.
 * It does NOT support headings or hyperlinks, so we convert those.
 */
export function markdownToWhatsApp(text: string): string {
  return convertOutsideCode(text, (segment) =>
    segment
      // Headings: ## text → *text* (bold on own line)
      .replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, content) => `*${content}*`)
      // Bold: **text** or __text__ → *text*
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/__(.+?)__/g, "*$1*")
      // Strikethrough: ~~text~~ → ~text~
      .replace(/~~(.+?)~~/g, "~$1~")
      // Links: [text](url) → text (url) — WhatsApp auto-links URLs
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      // Bullet lists: - item or * item → • item
      .replace(/^(\s*)[-*]\s+/gm, "$1• "),
  );
}

/**
 * Split text into chunks that fit within WhatsApp's message length limit.
 * Converts markdown to WhatsApp formatting before chunking.
 */
export function formatResponse(text: string): string[] {
  return formatAndChunk(text, WA_MAX_LENGTH, markdownToWhatsApp);
}
