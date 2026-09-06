import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { collectTagFields, firstField, readSingleFileMultipart } from "./multipart.js";
import { safeFetch, SsrfError } from "../../shared/ssrf-guard.js";
import { readFileUnderPolicy } from "./read-security.js";
import { logger } from "../../shared/logger.js";
import {
  getFilesByIds,
  insertMessage,
  setFilePath,
  updateArtifactMetadata,
  type ArtifactKind,
  type MessageMedia,
} from "../../sessions/registry.js";
import type { ApiContext } from "../api/context.js";
import { badRequest, BodyTooLargeError, FileRequestError, json, readBody, serverError } from "./responses.js";
import { bufferResponseWithLimit, saveFile } from "./uploads.js";
import { safeRmSync } from "../../shared/safe-delete.js";
import {
  FILES_DIR,
  buildMessageMedia,
  sanitizeUploadFilename,
  uploadDir,
} from "./storage.js";

// Upper bound on a JSON attachment body: the 50 MiB decoded-content cap plus
// base64 inflation (~4/3) and JSON overhead. Bounds heap before decode (AR-07).
const MAX_ATTACHMENT_JSON_BODY_BYTES = 96 * 1024 * 1024;

export function fileIdsToMedia(fileIds: unknown): MessageMedia[] {
  if (!Array.isArray(fileIds)) return [];
  const ids = fileIds.filter((id): id is string => typeof id === "string" && !!id.trim());
  const byId = new Map(getFilesByIds(ids).map((meta) => [meta.id, meta]));
  const media: MessageMedia[] = [];
  for (const id of ids) {
    const meta = byId.get(id);
    if (meta) media.push(buildMessageMedia(meta));
  }
  return media;
}

export function rehomeAttachmentsToSession(fileIds: unknown, sessionId: string): void {
  if (!Array.isArray(fileIds)) return;
  const destDir = uploadDir(sessionId);
  const ids = fileIds.filter((id): id is string => typeof id === "string" && !!id.trim());
  const byId = new Map(getFilesByIds(ids).map((meta) => [meta.id, meta]));
  for (const id of ids) {
    const meta = byId.get(id);
    if (!meta) continue;
    // Stored uploads live under their sanitized basename (see saveFile); sanitize
    // here too so a registered artifact's raw/`..`-laden filename cannot make
    // `current` escape FILES_DIR and turn the rename below into an arbitrary move.
    const current = path.join(FILES_DIR, meta.id, sanitizeUploadFilename(meta.filename));
    if (!fs.existsSync(current)) continue;
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, sanitizeUploadFilename(meta.filename));
    try {
      fs.renameSync(current, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        fs.copyFileSync(current, dest);
        safeRmSync(current, { within: FILES_DIR, recursive: false, label: "attachment file" });
      } else {
        logger.warn(`Failed to re-home attachment ${id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
    try {
      fs.rmdirSync(path.join(FILES_DIR, meta.id));
    } catch {
    }
    setFilePath(meta.id, dest);
    updateArtifactMetadata(meta.id, { sourcePath: meta.sourcePath ?? current });
    logger.info(`Re-homed attachment ${meta.filename} (${id}) into session ${sessionId} uploads`);
  }
}

async function finalizeAttachment(
  res: ServerResponse,
  sessionId: string,
  filename: string,
  buffer: Buffer,
  caption: string,
  context: ApiContext,
  opts: {
    artifactKind?: ArtifactKind;
    sourceUrl?: string | null;
    sourcePath?: string | null;
    tags?: string[];
    notes?: string | null;
  } = {},
): Promise<void> {
  const meta = await saveFile({
    id: crypto.randomUUID(),
    filename,
    buffer,
    customPath: null,
    open: false,
    sessionId,
    artifactKind: opts.artifactKind ?? "manual",
    producingRunId: opts.artifactKind === "generated" ? sessionId : null,
    sourceUrl: opts.sourceUrl ?? null,
    sourcePath: opts.sourcePath ?? null,
    tags: opts.tags,
    notes: opts.notes ?? null,
  }, context);
  const media = buildMessageMedia(meta);
  const messageId = insertMessage(sessionId, "assistant", caption, [media]);
  const timestamp = Date.now();
  context.emit("session:attachment", { sessionId, id: messageId, content: caption, media: [media], timestamp });
  logger.info(`Attachment pushed to session ${sessionId}: ${meta.filename} (${meta.id})`);
  json(res, { ...meta, media, message: { id: messageId, role: "assistant", content: caption, media: [media], timestamp } }, 201);
}

async function handleAttachmentMultipart(
  req: HttpRequest,
  res: ServerResponse,
  sessionId: string,
  context: ApiContext,
): Promise<void> {
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const outcome = await readSingleFileMultipart(req, {
    maxFileBytes: MAX_FILE_SIZE,
    tooLargeMessage: () => `File exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit`,
  });
  if (!outcome.ok) {
    json(res, { error: outcome.reason }, outcome.status);
    return;
  }

  const caption = firstField(outcome.fields, "text") ?? firstField(outcome.fields, "caption") ?? "";
  const artifactKind = firstField(outcome.fields, "artifactKind") as ArtifactKind | undefined;
  const notes = firstField(outcome.fields, "notes") ?? null;
  const tags = collectTagFields(outcome.fields);

  try {
    await finalizeAttachment(res, sessionId, outcome.filename, outcome.buffer, caption, context, {
      artifactKind: artifactKind ?? "manual",
      tags,
      notes,
    });
  } catch (err) {
    serverError(res, err instanceof Error ? err.message : "Attachment failed");
  }
}

async function handleAttachmentJson(
  req: HttpRequest,
  res: ServerResponse,
  sessionId: string,
  context: ApiContext,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    // Base64 `content` may hold up to the 50 MiB decoded cap below (~68 MiB
    // encoded); cap the buffered JSON with headroom so an oversized/streamed body
    // is rejected before it can exhaust the heap (AR-07).
    body = JSON.parse(await readBody(req, { maxBytes: MAX_ATTACHMENT_JSON_BODY_BYTES }));
  } catch (err) {
    if (err instanceof BodyTooLargeError) return json(res, { error: "Payload too large" }, 413);
    return badRequest(res, "Invalid JSON body");
  }

  const localPath = body.path as string | undefined;
  const content = body.content as string | undefined;
  const url = body.url as string | undefined;
  const caption = typeof body.text === "string" ? body.text : (typeof body.caption === "string" ? body.caption : "");
  let filename = body.filename as string | undefined;
  const artifactKind = body.artifactKind as ArtifactKind | undefined;
  const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined;
  const notes = typeof body.notes === "string" ? body.notes : null;

  const provided = [localPath, content, url].filter(Boolean).length;
  if (provided === 0) return badRequest(res, "one of path, content (base64), or url is required");
  if (provided > 1) return badRequest(res, "path, content, and url are mutually exclusive");

  const MAX = 50 * 1024 * 1024;
  let buffer: Buffer;
  // The path we actually opened, so provenance records the file that was read
  // rather than the spelling the caller happened to send.
  let sourcePath: string | null = null;

  if (localPath) {
    // Apply the same secret-file policy /api/files/read enforces (IOP-CF-001):
    // this route previously read any local path directly, bypassing the denylist
    // that blocks .env, private keys, ~/.ssh, and stored auth/credential files.
    // CF2-103 (remaining gap): a configured gateway.fileReadRoots allowlist was
    // never consulted here either, unlike run-attachments.ts's equivalent check.
    // UPS-A1: the policy decision and the read are now bound to one descriptor,
    // so a path component swapped to a symlink between them cannot hand back a
    // file the denylist would have refused.
    const read = readFileUnderPolicy(localPath, {
      maxBytes: MAX,
      context,
      authenticated: true,
      tooLargeMessage: () => "File exceeds 50 MB limit",
    });
    if (!read.ok) return badRequest(res, read.reason);
    buffer = read.buffer;
    sourcePath = read.realPath;
    if (!filename) filename = path.basename(read.realPath);
  } else if (content) {
    buffer = Buffer.from(content, "base64");
    if (buffer.length > MAX) return badRequest(res, "File exceeds 50 MB limit");
    if (!filename) return badRequest(res, "filename is required when sending base64 content");
  } else {
    try {
      // safeFetch re-validates every redirect hop (SEC-SSRF-001); the streaming
      // buffer enforces the 50 MB cap incrementally instead of materializing the
      // whole response first (SEC-DOS-002).
      const response = await safeFetch(url!);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return serverError(res, `Failed to fetch URL: ${response.status} ${response.statusText}`);
      }
      buffer = await bufferResponseWithLimit(response, MAX);
      if (!filename) filename = path.basename(new URL(url!).pathname) || "download";
    } catch (err) {
      if (err instanceof SsrfError) return badRequest(res, err.message);
      if (err instanceof FileRequestError) return badRequest(res, err.message);
      return serverError(res, `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    await finalizeAttachment(res, sessionId, filename!, buffer, caption, context, {
      artifactKind: artifactKind ?? (localPath ? "generated" : (url ? "downloaded" : "manual")),
      sourceUrl: url ?? null,
      sourcePath,
      tags,
      notes,
    });
  } catch (err) {
    serverError(res, err instanceof Error ? err.message : "Attachment failed");
  }
}

export async function handleSessionAttachment(
  req: HttpRequest,
  res: ServerResponse,
  sessionId: string,
  context: ApiContext,
): Promise<void> {
  const contentType = (req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    await handleAttachmentMultipart(req, res, sessionId, context);
  } else {
    await handleAttachmentJson(req, res, sessionId, context);
  }
}
