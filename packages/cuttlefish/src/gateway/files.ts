import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { FILES_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { safeRmSync } from "../shared/safe-delete.js";
import { deleteFile, getFile, listFiles } from "../sessions/registry.js";
import type { ApiContext } from "./api/context.js";
import { handleSessionAttachment, fileIdsToMedia, rehomeAttachmentsToSession } from "./files/attachments.js";
import { fileEtag, isFileNotModified } from "./files/http-cache.js";
import {
  MAX_READ_SIZE,
  assessFileRead,
  classifyFile,
  isAllowedReadPath,
  readPathCandidates,
  resolveReadPath,
  type FileClassification,
  type FileReadAssessment,
} from "./files/read-security.js";
import { badRequest, json, notFound, serverError } from "./files/responses.js";
import {
  cleanupOldUploads,
  ensureFilesDir,
  isServablePath,
  resolveCustomUploadPath,
  sanitizeSessionId,
  sanitizeUploadFilename,
  uploadDir,
} from "./files/storage.js";
import { buildRemoteUploadBody, handleTransfer, remoteUploadHeaders } from "./files/transfer.js";
import { handleJsonUpload, handleMultipartUpload, allowUploadedFileOpen } from "./files/uploads.js";

export {
  allowUploadedFileOpen,
  buildRemoteUploadBody,
  cleanupOldUploads,
  ensureFilesDir,
  fileEtag,
  fileIdsToMedia,
  handleSessionAttachment,
  isAllowedReadPath,
  isFileNotModified,
  isServablePath,
  MAX_READ_SIZE,
  readPathCandidates,
  rehomeAttachmentsToSession,
  remoteUploadHeaders,
  resolveCustomUploadPath,
  resolveReadPath,
  sanitizeSessionId,
  sanitizeUploadFilename,
  uploadDir,
  assessFileRead,
  classifyFile,
};
export type { FileClassification, FileReadAssessment };

/** Route handler for all /api/files endpoints. Returns true if handled. */
export async function handleFilesRequest(
  req: HttpRequest,
  res: ServerResponse,
  pathname: string,
  method: string,
  context: ApiContext,
): Promise<boolean> {
  // GET /api/files/read?path=<path> — read a configured-root file for inline display.
  // Guards: auth at the server boundary, root allowlist, 5 MB size cap, binary detection.
  if (method === "GET" && pathname === "/api/files/read") {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const requested = reqUrl.searchParams.get("path");
    if (!requested) {
      badRequest(res, "path query parameter is required");
      return true;
    }
    const { resolvedPath } = resolveReadPath(requested);
    if (!resolvedPath) {
      notFound(res);
      return true;
    }
    if (!fs.statSync(resolvedPath).isFile()) {
      badRequest(res, "Not a file");
      return true;
    }
    const assessment = assessFileRead(resolvedPath, { authenticated: true });
    if (!assessment.allowed) {
      json(res, { error: assessment.reason || "File read blocked by security policy" }, 403);
      return true;
    }
    if (!isAllowedReadPath(resolvedPath, context)) {
      json(res, { error: "File path is outside configured fileReadRoots" }, 403);
      return true;
    }
    try {
      const c = classifyFile(resolvedPath);
      json(res, {
        path: requested,
        ...(context.getConfig().gateway?.exposeResolvedFilePaths ? { resolvedPath } : {}),
        mime: c.mime,
        size: c.size,
        ...(c.tooLarge ? { tooLarge: true } : {}),
        ...(c.binary ? { binary: true } : {}),
        ...(c.content !== undefined ? { content: c.content } : {}),
      });
    } catch (err) {
      serverError(res, err instanceof Error ? err.message : "Read failed");
    }
    return true;
  }

  // POST /api/files/transfer — send files to remote gateway
  if (method === "POST" && pathname === "/api/files/transfer") {
    await handleTransfer(req, res, context);
    return true;
  }

  // POST /api/files — upload
  if (method === "POST" && pathname === "/api/files") {
    const contentType = (req.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("multipart/form-data")) {
      await handleMultipartUpload(req, res, context);
    } else {
      await handleJsonUpload(req, res, context);
    }
    return true;
  }

  // GET /api/files — list all
  if (method === "GET" && pathname === "/api/files") {
    json(res, listFiles());
    return true;
  }

  // GET /api/files/:id/meta — file metadata
  const metaMatch = pathname.match(/^\/api\/files\/([^/]+)\/meta$/);
  if (method === "GET" && metaMatch) {
    const meta = getFile(metaMatch[1]);
    if (!meta) { notFound(res); return true; }
    json(res, meta);
    return true;
  }

  // GET /api/files/:id — download file
  const dlMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (method === "GET" && dlMatch) {
    const meta = getFile(dlMatch[1]);
    if (!meta) { notFound(res); return true; }
    // Managed storage first, then the recorded path (e.g. session uploads under UPLOADS_DIR).
    // Only ever serve files that resolve inside FILES_DIR/UPLOADS_DIR — never an arbitrary path.
    const candidates = [path.join(FILES_DIR, meta.id, meta.filename), meta.path].filter(
      (p): p is string => !!p,
    );
    const filePath = candidates.find((p) => isServablePath(p) && fs.existsSync(p) && fs.statSync(p).isFile());
    if (!filePath) {
      notFound(res);
      return true;
    }
    const stat = fs.statSync(filePath);
    // Content-immutable: cache forever + revalidate cheaply with ETag/Last-Modified.
    const etag = fileEtag(meta.id, stat.size);
    const cacheHeaders = {
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: etag,
      "Last-Modified": stat.mtime.toUTCString(),
    };
    // Conditional GET → 304 with no body (validators only). Cheaper than re-streaming.
    if (isFileNotModified(req.headers, etag, stat.mtimeMs)) {
      res.writeHead(304, cacheHeaders);
      res.end();
      return true;
    }
    // Sanitize filename to prevent Content-Disposition header injection.
    // Strip anything that isn't alphanumeric, dash, underscore, period, or space,
    // then use the RFC 5987 filename* parameter with percent-encoding.
    const sanitizedFilename = meta.filename.replace(/[^\w.\- ]/g, "_");
    res.writeHead(200, {
      "Content-Type": meta.mimetype || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${sanitizedFilename}"; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
      "Content-Length": stat.size,
      ...cacheHeaders,
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // DELETE /api/files/:id
  const delMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (method === "DELETE" && delMatch) {
    const id = delMatch[1];
    const meta = getFile(id);
    if (!meta) { notFound(res); return true; }

    // Remove managed storage directory
    const fileDir = path.join(FILES_DIR, id);
    safeRmSync(fileDir, { within: FILES_DIR, label: "file storage dir" });
    // Session-scoped uploads live under UPLOADS_DIR (recorded in meta.path) — remove that too.
    if (meta.path && isServablePath(meta.path) && fs.existsSync(meta.path)) {
      fs.rmSync(meta.path, { force: true });
    }

    deleteFile(id);
    context.emit("file:deleted", { id, filename: meta.filename });
    logger.info(`File deleted: ${meta.filename} (${id})`);
    json(res, { status: "deleted" });
    return true;
  }

  return false;
}
