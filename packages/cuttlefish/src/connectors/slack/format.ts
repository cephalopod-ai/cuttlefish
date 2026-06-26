import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { convertOutsideCode, formatAndChunk } from "../shared/format.js";
import { safeWriteFile } from "../../shared/safe-write.js";

const SLACK_MAX_LENGTH = 3000;

/**
 * Convert standard markdown to Slack mrkdwn format.
 * Handles headings, bold, strikethrough, links, and bullet lists.
 * Preserves code blocks and inline code untouched.
 */
export function markdownToSlackMrkdwn(text: string): string {
  return convertOutsideCode(text, (segment) =>
    segment
      // Headings: ## text → *text* (must be at start of line)
      .replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, content) => `*${content}*`)
      // Bold: **text** or __text__ → *text*
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/__(.+?)__/g, "*$1*")
      // Strikethrough: ~~text~~ → ~text~
      .replace(/~~(.+?)~~/g, "~$1~")
      // Links: [text](url) → <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
      // Bullet lists: - item or * item → • item (with optional indentation)
      .replace(/^(\s*)[-*]\s+/gm, "$1• "),
  );
}

/**
 * Split text into chunks that fit within Slack's message length limit.
 * Converts markdown to Slack mrkdwn format before chunking.
 */
export function formatResponse(text: string): string[] {
  return formatAndChunk(text, SLACK_MAX_LENGTH, markdownToSlackMrkdwn);
}

/**
 * Download a Slack file attachment to a local directory.
 * Returns the local file path.
 */
export async function downloadAttachment(
  url: string,
  token: string,
  destDir: string,
): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`);
  }

  // Generate unique filename preserving extension from URL if possible
  const urlPath = new URL(url).pathname;
  const ext = path.extname(urlPath) || "";
  const filename = `${randomUUID()}${ext}`;
  const localPath = path.join(destDir, filename);

  const buffer = Buffer.from(await response.arrayBuffer());
  safeWriteFile(localPath, buffer, { fsync: false }); // atomic media write; durability unneeded

  return localPath;
}
