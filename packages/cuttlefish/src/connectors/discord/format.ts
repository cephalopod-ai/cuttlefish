import { formatAndChunk } from "../shared/format.js";

const DISCORD_MAX_LENGTH = 2000;

/**
 * Split text into chunks that fit within Discord's message length limit.
 * Discord renders standard markdown natively, so no conversion is needed.
 */
export function formatResponse(text: string): string[] {
  return formatAndChunk(text, DISCORD_MAX_LENGTH);
}

export async function downloadAttachment(
  url: string,
  destDir: string,
  filename: string,
): Promise<string> {
  const { default: path } = await import("node:path");
  const { safeWriteFile } = await import("../../shared/safe-write.js");
  const destPath = path.join(destDir, filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  // Atomic (no torn media served); fsync:false — a lost download just re-fetches.
  safeWriteFile(destPath, buffer, { fsync: false });
  return destPath;
}
