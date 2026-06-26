import type { IncomingMessage as HttpRequest } from "node:http";

export function fileEtag(id: string, size: number): string {
  return `"${id}-${size}"`;
}

export function isFileNotModified(
  headers: HttpRequest["headers"],
  etag: string,
  lastModifiedMs: number,
): boolean {
  const inm = headers["if-none-match"];
  if (inm) {
    const norm = (t: string) => t.trim().replace(/^W\//, "");
    return inm === "*" || inm.split(",").some((t) => norm(t) === norm(etag));
  }
  const ims = headers["if-modified-since"];
  if (ims) {
    const since = Date.parse(ims);
    if (!Number.isNaN(since)) return Math.floor(lastModifiedMs / 1000) * 1000 <= since;
  }
  return false;
}
