import fs from "node:fs";

/**
 * Read only the first line of a file via a single bounded read.
 *
 * `readFileSync(...).split("\n", 1)[0]` materializes the ENTIRE file to get
 * line one — on engine transcript trees that pattern pulled hundreds of MB
 * through the heap per lookup (every .jsonl is read until the session id
 * matches). Transcript header lines are small JSON metadata, so a 64KB window
 * is generous; a first line longer than `maxBytes` comes back truncated (the
 * caller's JSON.parse fails and it is treated as no-match, which is the safe
 * direction).
 */
export function readFirstLineSync(filePath: string, maxBytes = 64 * 1024): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    if (bytesRead <= 0) return undefined;
    const text = buf.subarray(0, bytesRead).toString("utf-8");
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } catch {
    return undefined;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}
