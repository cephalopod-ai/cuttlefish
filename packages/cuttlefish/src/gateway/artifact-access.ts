import fs from "node:fs";
import path from "node:path";
import { getFile, type FileMeta } from "../sessions/registry.js";
import { UPLOADS_DIR, sanitizeSessionId } from "./files/storage.js";
import type { GatewayPrincipal } from "./scoped-token.js";

export class ArtifactAccessError extends Error {
  constructor() {
    super("Session-scoped callers can only attach their own managed uploads");
    this.name = "ArtifactAccessError";
  }
}

/** FileMeta has no owner field. Only the canonical managed upload namespace
 * proves session ownership; sourcePath and producingRunId are caller claims. */
function isSessionUpload(meta: FileMeta, sessionId: string): boolean {
  if (!meta.path || sanitizeSessionId(sessionId) !== sessionId) return false;
  try {
    const root = fs.realpathSync.native(UPLOADS_DIR);
    const diskPath = fs.realpathSync.native(meta.path);
    const relative = path.relative(root, diskPath);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
    const parts = relative.split(path.sep);
    return parts.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0]!) && parts[1] === sessionId;
  } catch {
    return false;
  }
}

export function resolveAttachmentArtifact(id: string, principal?: GatewayPrincipal): FileMeta {
  const meta = getFile(id);
  if (principal?.kind === "session" && (!meta || !isSessionUpload(meta, principal.sessionId))) {
    // Missing and inaccessible IDs have the same response, without an oracle.
    throw new ArtifactAccessError();
  }
  if (!meta) throw new Error(`Attachment artifact not found: ${id}`);
  return meta;
}

/** Preflight opaque references before a new session or continuation mutates
 * persistent state. The complete resolver also applies this check at use. */
export function assertScopedArtifactReferences(body: Record<string, unknown>, principal?: GatewayPrincipal): void {
  if (principal?.kind !== "session") return;
  for (const collection of [body.attachments, body.resources]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      const id = typeof item === "string" ? item.trim()
        : item && typeof item === "object" && !Array.isArray(item) && typeof item.artifactId === "string"
          ? item.artifactId.trim() : "";
      if (id) resolveAttachmentArtifact(id, principal);
    }
  }
}
