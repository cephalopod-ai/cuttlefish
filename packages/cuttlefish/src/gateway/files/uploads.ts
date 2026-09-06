import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { collectTagFields, firstField, readSingleFileMultipart } from "./multipart.js";
import { readJsonBody } from "../http-helpers.js";
import type { ApiContext } from "../api/context.js";
import { safeFetch, SsrfError } from "../../shared/ssrf-guard.js";
import { logger } from "../../shared/logger.js";
import { insertFile, type ArtifactKind, type FileMeta } from "../../sessions/registry.js";
import { principalBodySessionForbidden, type GatewayPrincipal } from "../auth.js";
import { badRequest, FileRequestError, json, serverError } from "./responses.js";
import {
  FILES_DIR,
  mimeFromFilename,
  resolveCustomUploadPath,
  sanitizeUploadFilename,
  uploadDir,
} from "./storage.js";

export function allowUploadedFileOpen(context: Pick<ApiContext, "getConfig">): boolean {
  return context.getConfig().gateway?.allowFileOpen === true;
}

function allowCustomUploadPaths(context: ApiContext): boolean {
  return context.getConfig().gateway?.allowFileCustomPaths === true;
}

const MAX_UPLOAD_SIZE_MB = 50;
const MAX_UPLOAD_SIZE = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_JSON_UPLOAD_BODY_SIZE = MAX_UPLOAD_SIZE * 2;

function uploadTooLargeMessage(): string {
  return `File exceeds ${MAX_UPLOAD_SIZE_MB} MB limit`;
}

/**
 * AR-04: an upload's target session lives in the request body (`sessionId`),
 * which the transport-layer scoped-token gate (URL-only) cannot see. Without
 * this a session-scoped agent token could stash an upload under another
 * session by naming its id in the body. Mirrors the guard used by
 * `handleTalkApi`'s `rejectCrossSessionBody` (talk/routes.ts).
 */
function rejectCrossSessionUpload(req: HttpRequest, res: ServerResponse, bodySessionId: unknown): boolean {
  const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
  if (!principalBodySessionForbidden(principal, bodySessionId)) return false;
  json(res, { error: "Forbidden: session-scoped token cannot target another session" }, 403);
  return true;
}

function estimateBase64DecodedBytes(content: string): number {
  let normalizedLength = 0;
  let trailing = "";
  let trailingPrev = "";

  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
    normalizedLength++;
    trailingPrev = trailing;
    trailing = content[i];
  }

  if (normalizedLength === 0) return 0;

  let padding = 0;
  if (trailing === "=") padding++;
  if (trailing === "=" && trailingPrev === "=") padding++;
  return Math.floor((normalizedLength * 3) / 4) - padding;
}

export async function bufferResponseWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new FileRequestError(uploadTooLargeMessage());
    }
  }

  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FileRequestError(uploadTooLargeMessage());
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

interface UploadResult {
  id: string;
  filename: string;
  buffer: Buffer;
  mimetype?: string | null;
  customPath: string | null;
  open: boolean;
  sessionId?: string | null;
  artifactKind?: ArtifactKind;
  producingRunId?: string | null;
  sourceUrl?: string | null;
  sourcePath?: string | null;
  tags?: string[];
  notes?: string | null;
}

export async function saveFile(result: UploadResult, context: ApiContext): Promise<FileMeta> {
  const safeName = sanitizeUploadFilename(result.filename);
  const customPath = resolveCustomUploadPath(result.customPath);
  if (result.customPath && (!allowCustomUploadPaths(context) || !customPath)) {
    throw new FileRequestError("custom upload paths are disabled or outside managed storage");
  }
  if (customPath) {
    try {
      await fs.promises.access(customPath);
      throw new FileRequestError("file already exists at custom path; use a different path or delete the existing file");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const sessionScoped = !!result.sessionId;
  const storageDir = sessionScoped
    ? path.join(uploadDir(result.sessionId!), result.id)
    : `${FILES_DIR}/${result.id}`;
  const storagePath = path.join(storageDir, safeName);

  const mimetype = result.mimetype?.trim() || mimeFromFilename(safeName);
  const sha256 = crypto.createHash("sha256").update(result.buffer).digest("hex");
  let wroteStorage = false;
  let wroteCustom = false;
  let meta: FileMeta;
  try {
    await fs.promises.mkdir(storageDir, { recursive: true });
    await fs.promises.writeFile(storagePath, result.buffer);
    wroteStorage = true;
    if (customPath) {
      await fs.promises.mkdir(path.dirname(customPath), { recursive: true });
      await fs.promises.writeFile(customPath, result.buffer);
      wroteCustom = true;
    }
    meta = insertFile({
      id: result.id,
      filename: safeName,
      size: result.buffer.length,
      mimetype,
      path: sessionScoped ? storagePath : customPath,
      sha256,
      artifactKind: result.artifactKind,
      producingRunId: result.producingRunId ?? null,
      sourceUrl: result.sourceUrl ?? null,
      sourcePath: result.sourcePath ?? null,
      tags: result.tags,
      notes: result.notes ?? null,
    });
  } catch (err) {
    if (wroteCustom && customPath) {
      try { await fs.promises.rm(customPath, { force: true }); } catch {}
    }
    if (wroteStorage) {
      try { await fs.promises.rm(storagePath, { force: true }); } catch {}
      try { await fs.promises.rmdir(storageDir); } catch {}
    }
    throw err;
  }

  if (result.open && allowUploadedFileOpen(context)) {
    const targetPath = customPath || storagePath;
    const { spawn } = await import("node:child_process");
    spawn("open", [targetPath], { stdio: "ignore", detached: true }).unref();
  }

  context.emit("file:uploaded", { id: result.id, filename: result.filename, size: result.buffer.length });
  logger.info(`File uploaded: ${result.filename} (${result.id}, ${result.buffer.length} bytes)`);

  return meta;
}

export async function handleMultipartUpload(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  const outcome = await readSingleFileMultipart(req, {
    maxFileBytes: MAX_UPLOAD_SIZE,
    tooLargeMessage: uploadTooLargeMessage,
  });
  if (!outcome.ok) {
    json(res, { error: outcome.reason }, outcome.status);
    return;
  }

  const customPath = firstField(outcome.fields, "path") ?? null;
  const openField = firstField(outcome.fields, "open");
  const open = openField === "true" || openField === "1";
  const sessionId = firstField(outcome.fields, "sessionId") ?? null;
  const artifactKind = firstField(outcome.fields, "artifactKind") as ArtifactKind | undefined;
  const notes = firstField(outcome.fields, "notes") ?? null;
  const tags = collectTagFields(outcome.fields);

  if (rejectCrossSessionUpload(req, res, sessionId)) return;

  try {
    const meta = await saveFile({
      id: crypto.randomUUID(),
      filename: outcome.filename,
      buffer: outcome.buffer,
      customPath,
      open,
      sessionId,
      artifactKind: artifactKind ?? "input",
      sourcePath: customPath,
      tags,
      notes,
    }, context);
    json(res, meta, 201);
  } catch (err) {
    if (err instanceof FileRequestError) {
      badRequest(res, err.message);
      return;
    }
    serverError(res, err instanceof Error ? err.message : "Upload failed");
  }
}

export async function handleJsonUpload(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  const parsed = await readJsonBody(req, res, { maxBytes: MAX_JSON_UPLOAD_BODY_SIZE });
  if (!parsed.ok) return;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    badRequest(res, "Invalid JSON body");
    return;
  }
  const body = parsed.body as Record<string, unknown>;

  const filename = body.filename as string | undefined;
  const content = body.content as string | undefined;
  const url = body.url as string | undefined;
  const customPath = (body.path as string) || null;
  const open = !!body.open;
  const sessionId = (body.sessionId as string) || null;
  const artifactKind = body.artifactKind as ArtifactKind | undefined;
  const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined;
  const notes = typeof body.notes === "string" ? body.notes : null;

  if (!filename) return badRequest(res, "filename is required");
  if (content && url) return badRequest(res, "content and url are mutually exclusive");
  if (!content && !url) return badRequest(res, "content or url is required");
  if (rejectCrossSessionUpload(req, res, body.sessionId)) return;

  let buffer: Buffer;

  if (content) {
    if (estimateBase64DecodedBytes(content) > MAX_UPLOAD_SIZE) {
      return badRequest(res, uploadTooLargeMessage());
    }
    try {
      buffer = Buffer.from(content, "base64");
    } catch {
      return badRequest(res, "Invalid base64 content");
    }
    if (buffer.length > MAX_UPLOAD_SIZE) {
      return badRequest(res, uploadTooLargeMessage());
    }
  } else {
    try {
      // safeFetch re-validates every redirect hop against the SSRF guard, so a
      // 3xx to a private/metadata address cannot slip past the initial check.
      const response = await safeFetch(url!);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return serverError(res, `Failed to fetch URL: ${response.status} ${response.statusText}`);
      }
      buffer = await bufferResponseWithLimit(response, MAX_UPLOAD_SIZE);
    } catch (err) {
      if (err instanceof SsrfError) return badRequest(res, err.message);
      if (err instanceof FileRequestError) {
        return badRequest(res, err.message);
      }
      return serverError(res, `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (buffer.length > MAX_UPLOAD_SIZE) {
      return badRequest(res, uploadTooLargeMessage());
    }
  }

  try {
    const meta = await saveFile({
      id: crypto.randomUUID(),
      filename,
      buffer,
      customPath,
      open,
      sessionId,
      artifactKind: artifactKind ?? (url ? "downloaded" : "input"),
      sourceUrl: url ?? null,
      sourcePath: customPath,
      tags,
      notes,
    }, context);
    json(res, meta, 201);
  } catch (err) {
    if (err instanceof FileRequestError) {
      return badRequest(res, err.message);
    }
    serverError(res, err instanceof Error ? err.message : "Upload failed");
  }
}
