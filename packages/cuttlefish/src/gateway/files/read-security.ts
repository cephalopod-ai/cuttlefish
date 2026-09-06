import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactText } from "../../shared/redact.js";
import type { ApiContext } from "../api/context.js";
import { GATEWAY_INFO_FILE } from "../../shared/paths.js";
import { CUTTLEFISH_HOME, expandPath, mimeFromFilename } from "./storage.js";

export const MAX_READ_SIZE = 5 * 1024 * 1024;

function isBinaryMime(mime: string): boolean {
  return (
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime.startsWith("font/") ||
    mime === "application/pdf" ||
    mime === "application/zip" ||
    mime === "application/gzip" ||
    mime === "application/x-tar" ||
    mime === "application/octet-stream" ||
    mime === "application/msword" ||
    mime.startsWith("application/vnd.")
  );
}

export function readPathCandidates(requestedPath: string): string[] {
  const p = String(requestedPath ?? "").trim();
  if (!p) return [];
  // path.isAbsolute (not startsWith("/")) so Windows absolute paths (C:\…,
  // UNC) take the absolute branch instead of being joined onto the roots.
  if (path.isAbsolute(p) || p.startsWith("~")) {
    return [path.resolve(expandPath(p))];
  }
  return [
    path.resolve(CUTTLEFISH_HOME, p),
    path.resolve(os.homedir(), "Projects", p),
    path.resolve(process.cwd(), p),
    path.resolve(p),
  ];
}

export function resolveReadPath(requestedPath: string): { resolvedPath: string | null; candidates: string[] } {
  const candidates = readPathCandidates(requestedPath);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { resolvedPath: candidate, candidates };
      }
    } catch {
    }
  }
  return { resolvedPath: null, candidates };
}

export interface FileReadAssessment { allowed: boolean; reason?: string }

function pathSegments(absPath: string): string[] {
  return path.resolve(absPath).split(path.sep).filter(Boolean).map((s) => s.toLowerCase());
}

function realpathOrResolved(absPath: string): string {
  const resolved = path.resolve(absPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isInsidePath(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

function assessSingleResolvedPath(resolved: string): FileReadAssessment {
  const base = path.basename(resolved).toLowerCase();
  const segments = pathSegments(resolved);
  const home = realpathOrResolved(os.homedir());
  const cuttlefishHome = realpathOrResolved(CUTTLEFISH_HOME);
  if (base.startsWith(".env")) return { allowed: false, reason: "Refusing to read environment secret files" };
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.pem|.*\.key|auth\.json|credentials(?:\.json)?|\.credentials(?:\.json)?|token(?:\.json|\.txt)?|application_default_credentials\.json|\.npmrc|\.netrc|\.git-credentials)$/i.test(base)) {
    return { allowed: false, reason: "Refusing to read private keys, credentials, or token files" };
  }
  if (isInsidePath(resolved, path.join(home, ".ssh"))) return { allowed: false, reason: "Refusing to read SSH secrets" };
  if (isInsidePath(resolved, path.join(cuttlefishHome, "secrets"))) return { allowed: false, reason: "Refusing to read Cuttlefish secrets" };
  if (isInsidePath(resolved, GATEWAY_INFO_FILE)) return { allowed: false, reason: "Refusing to read the Cuttlefish gateway admin token" };
  // Audit D-F9/F-06: config.yaml holds connector bot tokens / signing secrets.
  if (isInsidePath(resolved, path.join(cuttlefishHome, "config.yaml"))) return { allowed: false, reason: "Refusing to read the Cuttlefish config (connector credentials)" };
  if (segments.includes(".claude") && (base.startsWith("auth") || base.startsWith(".credentials"))) return { allowed: false, reason: "Refusing to read Claude auth files" };
  if (segments.includes(".codex") && base === "auth.json") return { allowed: false, reason: "Refusing to read Codex auth files" };
  if (segments.includes(".aws") && base === "credentials") return { allowed: false, reason: "Refusing to read AWS credentials" };
  if (segments.includes(".kube") && base === "config") return { allowed: false, reason: "Refusing to read kubeconfig" };
  if (segments.includes(".docker") && base === "config.json") return { allowed: false, reason: "Refusing to read Docker registry credentials" };
  if (segments.includes("gcloud") && base === "application_default_credentials.json") return { allowed: false, reason: "Refusing to read gcloud application default credentials" };
  return { allowed: true };
}

export function assessFileRead(absPath: string, _opts: { authenticated?: boolean } = {}): FileReadAssessment {
  const requested = path.resolve(expandPath(absPath));
  const candidates = [requested];
  const real = realpathOrResolved(requested);
  if (real !== requested) candidates.push(real);
  for (const candidate of candidates) {
    const assessment = assessSingleResolvedPath(candidate);
    if (!assessment.allowed) return assessment;
  }
  return { allowed: true };
}

export function isAllowedReadPath(
  absPath: string,
  context: Pick<ApiContext, "getConfig">,
): boolean {
  const gateway = (context.getConfig().gateway ?? {}) as Record<string, unknown> & {
    allowArbitraryFileRead?: boolean;
    fileReadRoots?: string[];
  };
  if (gateway.allowArbitraryFileRead === true) return true;
  const roots = gateway.fileReadRoots;
  // A missing allowlist must never silently become host-wide file access. The
  // documented default is Cuttlefish-managed state only; operators who need a
  // project directory must opt in with gateway.fileReadRoots, and the explicit
  // allowArbitraryFileRead escape hatch remains available for local installs.
  if (!Array.isArray(roots) || roots.length === 0) {
    return isInsidePath(realpathOrResolved(absPath), realpathOrResolved(CUTTLEFISH_HOME));
  }
  const resolved = realpathOrResolved(absPath);
  return roots.some((root) => isInsidePath(resolved, realpathOrResolved(root)));
}

/**
 * Bytes read under the standing file-read policy, bound to a single inode.
 *
 * `assessFileRead` + `isAllowedReadPath` decide on a *path*. A caller that then
 * re-opens that path has made its policy decision about one inode and its read
 * about whatever the path resolves to a few syscalls later — a path component
 * swapped to a symlink in between yields a file the denylist would have refused
 * (`.env`, `~/.ssh`, `gateway.json`). `readFileUnderPolicy` closes that window:
 * it opens once, holds the descriptor for the whole decision, and reads the
 * bytes back out of that same descriptor.
 */
export type PolicyReadResult =
  | { ok: true; buffer: Buffer; realPath: string; size: number }
  // `size` and `realPath` are carried on the `too_large` refusal so a caller
  // that reports an oversized file (rather than erroring on it) still has the
  // facts about the inode that was actually opened.
  | { ok: false; reason: string; code: PolicyReadRefusal; size?: number; realPath?: string };

export type PolicyReadRefusal =
  | "not_found"
  | "not_a_file"
  | "symlink"
  | "blocked"
  | "outside_roots"
  | "too_large"
  | "raced"
  | "io";

export interface PolicyReadOptions {
  /** Hard ceiling, enforced from `fstat` on the held descriptor. */
  maxBytes: number;
  /** When given, the descriptor's real path must also sit inside `gateway.fileReadRoots`. */
  context?: Pick<ApiContext, "getConfig">;
  authenticated?: boolean;
  /** Caller-worded size refusal; receives the real size in bytes. */
  tooLargeMessage?: (size: number) => string;
}

// O_NOFOLLOW is POSIX-only. Where the platform does not define it we fall back
// to an lstat pre-check, which is weaker (it is itself a path check) but still
// refuses the obvious symlinked leaf; the dev/ino equality check below is what
// binds the policy decision to the opened inode on every platform.
const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
// O_NONBLOCK matters because we open BEFORE we know what the path names. Opening
// a FIFO for reading blocks until a writer appears — synchronously, on the
// gateway's only thread — so a caller naming a fifo would wedge the process
// forever. With O_NONBLOCK the open returns immediately and `fstat` below
// refuses it for not being a regular file. It has no effect on regular files,
// which are the only thing this function ever goes on to read.
const O_NONBLOCK = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;

function readAllFromDescriptor(fd: number, size: number): Buffer | null {
  const buffer = Buffer.allocUnsafe(size);
  let read = 0;
  while (read < size) {
    const n = fs.readSync(fd, buffer, read, size - read, read);
    if (n <= 0) break;
    read += n;
  }
  return read === size ? buffer : null;
}

/**
 * Open `requestedPath` once, decide the standing file-read policy against the
 * descriptor we are holding, and return the bytes read from that descriptor.
 *
 * The path is canonicalised *after* the open and proven to name the same inode
 * (device + inode number) as the open descriptor, so the path the policy judged
 * and the bytes the caller receives cannot be two different files.
 */
export function readFileUnderPolicy(requestedPath: string, opts: PolicyReadOptions): PolicyReadResult {
  const resolved = path.resolve(expandPath(requestedPath));

  if (O_NOFOLLOW === 0) {
    try {
      if (fs.lstatSync(resolved).isSymbolicLink()) {
        return { ok: false, code: "symlink", reason: "Refusing to read through a symbolic link" };
      }
    } catch {
      return { ok: false, code: "not_found", reason: `File not found: ${requestedPath}` };
    }
  }

  let fd: number;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      return { ok: false, code: "symlink", reason: "Refusing to read through a symbolic link" };
    }
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, code: "not_found", reason: `File not found: ${requestedPath}` };
    }
    if (code === "EISDIR") return { ok: false, code: "not_a_file", reason: "Not a file" };
    return { ok: false, code: "io", reason: err instanceof Error ? err.message : "Cannot open file" };
  }

  try {
    const held = fs.fstatSync(fd, { bigint: true });
    // Regular files only: a directory, fifo, socket or device is not something
    // this function reads, and refusing here is what makes the O_NONBLOCK open
    // above safe.
    if (!held.isFile()) return { ok: false, code: "not_a_file", reason: "Not a file" };

    // Canonicalise after the open, then prove the canonical path still names the
    // inode we are holding. Without this the policy would be judging a path that
    // may already point somewhere else.
    let real: string;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      return { ok: false, code: "not_found", reason: `File not found: ${requestedPath}` };
    }
    let named: fs.BigIntStats;
    try {
      named = fs.lstatSync(real, { bigint: true });
    } catch {
      return { ok: false, code: "raced", reason: "File changed while it was being read" };
    }
    if (named.dev !== held.dev || named.ino !== held.ino) {
      return { ok: false, code: "raced", reason: "File changed while it was being read" };
    }

    const assessment = assessFileRead(real, { authenticated: opts.authenticated });
    if (!assessment.allowed) {
      return { ok: false, code: "blocked", reason: assessment.reason || "Refusing to read this file" };
    }
    if (opts.context && !isAllowedReadPath(real, opts.context)) {
      return { ok: false, code: "outside_roots", reason: `File is outside the configured fileReadRoots: ${requestedPath}` };
    }

    const size = Number(held.size);
    if (size > opts.maxBytes) {
      return {
        ok: false,
        code: "too_large",
        reason: opts.tooLargeMessage?.(size) ?? `File exceeds ${Math.floor(opts.maxBytes / 1024 / 1024)} MB limit`,
        size,
        realPath: real,
      };
    }

    const buffer = readAllFromDescriptor(fd, size);
    if (!buffer) return { ok: false, code: "raced", reason: "File changed while it was being read" };
    return { ok: true, buffer, realPath: real, size };
  } catch (err) {
    return { ok: false, code: "io", reason: err instanceof Error ? err.message : "Read failed" };
  } finally {
    try { fs.closeSync(fd); } catch { /* descriptor already gone */ }
  }
}

export interface FileClassification {
  mime: string;
  size: number;
  tooLarge: boolean;
  binary: boolean;
  content?: string;
}

/**
 * Classify bytes already read under policy. Separated from `classifyFile` so a
 * caller holding the bytes from `readFileUnderPolicy` never re-opens the path
 * just to be told what is in it.
 */
export function classifyBuffer(absPath: string, buffer: Buffer): FileClassification {
  const size = buffer.length;
  const mime = mimeFromFilename(absPath);

  if (isBinaryMime(mime)) {
    return { mime, size, tooLarge: false, binary: true };
  }

  const scanLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < scanLen; i++) {
    if (buffer[i] === 0) {
      return { mime, size, tooLarge: false, binary: true };
    }
  }

  return { mime, size, tooLarge: false, binary: false, content: redactText(buffer.toString("utf-8")) };
}

export function classifyFile(absPath: string): FileClassification {
  const stat = fs.statSync(absPath);
  const size = stat.size;
  const mime = mimeFromFilename(absPath);

  if (size > MAX_READ_SIZE) {
    return { mime, size, tooLarge: true, binary: false };
  }
  if (isBinaryMime(mime)) {
    return { mime, size, tooLarge: false, binary: true };
  }

  return classifyBuffer(absPath, fs.readFileSync(absPath));
}
