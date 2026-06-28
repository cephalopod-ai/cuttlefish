import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FILES_DIR, CUTTLEFISH_HOME, UPLOADS_DIR } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import { safeRmSync } from "../../shared/safe-delete.js";
import type { FileMeta, MessageMedia } from "../../sessions/registry.js";

export function ensureFilesDir(): void {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export function sanitizeUploadFilename(name: string): string {
  const base = path.basename(String(name ?? "").replace(/\\/g, "/")).trim();
  if (!base || /^\.+$/.test(base)) return "file";
  return base;
}

export function sanitizeSessionId(id: string): string {
  const cleaned = String(id ?? "").replace(/[^A-Za-z0-9._-]/g, "").replace(/^\.+/, "");
  if (!cleaned) return "unknown";
  return cleaned;
}

function todayBucket(): string {
  return new Date().toISOString().slice(0, 10);
}

function realpathOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

export function uploadDir(sessionId: string, date?: string): string {
  const bucket = date || todayBucket();
  return path.join(UPLOADS_DIR, bucket, sanitizeSessionId(sessionId));
}

export function isServablePath(absPath: string): boolean {
  const resolved = realpathOrResolved(absPath);
  return [FILES_DIR, UPLOADS_DIR].some((root) => {
    const r = realpathOrResolved(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

export function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function resolveCustomUploadPath(requestedPath: string | null | undefined): string | null {
  if (!requestedPath) return null;
  const resolved = path.resolve(expandPath(requestedPath));
  return isServablePath(resolved) ? resolved : null;
}

export function cleanupOldUploads(maxAgeDays = 30): number {
  if (!fs.existsSync(UPLOADS_DIR)) return 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ts = Date.parse(`${entry.name}T00:00:00.000Z`);
    if (Number.isNaN(ts) || ts >= cutoff) continue;
    try {
      safeRmSync(path.join(UPLOADS_DIR, entry.name), { within: UPLOADS_DIR, label: "upload bucket" });
      removed++;
    } catch (err) {
      logger.warn(`Failed to remove old upload bucket ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (removed > 0) logger.info(`Cleaned up ${removed} upload bucket(s) older than ${maxAgeDays} days`);
  return removed;
}

const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "application/javascript",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function mimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

export function mediaTypeFromMime(mime: string | null): MessageMedia["type"] {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("audio/")) return "audio";
  return "file";
}

export function buildMessageMedia(meta: FileMeta): MessageMedia {
  return {
    type: mediaTypeFromMime(meta.mimetype),
    url: `/api/files/${meta.id}`,
    name: meta.filename,
    mimeType: meta.mimetype ?? undefined,
    size: meta.size,
  };
}

export { FILES_DIR, CUTTLEFISH_HOME, UPLOADS_DIR };
