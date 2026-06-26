/**
 * Tail-read helper for append-only JSONL history files (e.g. cron run logs).
 * These files grow forever, so for large files only the trailing chunk is
 * read instead of buffering the whole file on the request path.
 */
import fs from "node:fs";

/** Files larger than this only have their trailing chunk read & parsed. */
export const JSONL_TAIL_CHUNK_BYTES = 1024 * 1024; // 1 MB

/**
 * Read the newest `limit` JSON entries from a JSONL file, newest first.
 * Corrupt/truncated lines (a crash mid-append can leave one) are skipped and
 * counted. A missing file yields an empty result.
 */
export async function readJsonlTail(
  filePath: string,
  limit: number,
  chunkBytes = JSONL_TAIL_CHUNK_BYTES,
): Promise<{ entries: unknown[]; skipped: number }> {
  let raw: string;
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > chunkBytes) {
      const fh = await fs.promises.open(filePath, "r");
      try {
        const buf = Buffer.alloc(chunkBytes);
        const { bytesRead } = await fh.read(buf, 0, chunkBytes, stat.size - chunkBytes);
        raw = buf.subarray(0, bytesRead).toString("utf-8");
      } finally {
        await fh.close();
      }
      // The chunk almost certainly starts mid-record — drop the first partial line.
      const nl = raw.indexOf("\n");
      raw = nl === -1 ? "" : raw.slice(nl + 1);
    } else {
      raw = await fs.promises.readFile(filePath, "utf-8");
    }
  } catch {
    return { entries: [], skipped: 0 };
  }

  const lines = raw.trim().split("\n").filter(Boolean);
  const entries: unknown[] = [];
  let skipped = 0;
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}
