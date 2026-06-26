import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { appendAudit, sha256Hex } from "./audit-log.js";

/**
 * Safe-write / integrity layer.
 *
 * One durable, atomic, optionally-audited file writer that every state mutation
 * in the daemon should funnel through. Replaces ad-hoc `writeFileSync` (torn
 * writes on crash) and the handful of tmp+rename sites that still skip `fsync`
 * (rename is atomic but the bytes may not be on disk when the rename lands).
 *
 * Guarantees per call:
 *   1. validate() runs BEFORE any tmp file exists — a bad value never touches disk.
 *   2. bytes are written to a pid-scoped tmp in the SAME dir, then fsync'd.
 *   3. the prior target is rotated into `.bak.N` (optional) before replacement.
 *   4. renameSync(tmp, target) — atomic swap on POSIX.
 *   5. the parent directory fd is fsync'd so the rename itself is durable.
 *   6. mode is re-applied (rename can carry tmp's mode; chmod is defensive).
 *   7. an audit record (sha256 of bytes, chained) is appended (optional).
 * On ANY failure the tmp file is unlinked in `finally`, so a thrown validate or
 * a mid-write crash never leaves a `.tmp-<pid>` turd or a half-written target.
 *
 * Synchronous by design: all current writers are sync, so this stays a drop-in
 * replacement without async-coloring callers. An async variant can be added
 * later without changing this core.
 */

export interface SafeWriteOpts {
  /** chmod to apply to the final file (e.g. 0o600 for secrets). */
  mode?: number;
  /** fsync the file fd AND the parent dir fd. Default true. */
  fsync?: boolean;
  /** Keep last-N previous versions as `<file>.bak.1..N`. Default 0 (off). */
  backups?: number;
  /** Append a chained record to the integrity ledger. Omit to skip auditing. */
  audit?: { actor: string; op?: string; auditLogPath?: string };
}

/** Best-effort fsync of a directory so a contained rename is durable. */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems (certain network mounts) reject opening/fsyncing a
    // directory. Durability of the rename degrades to file-only fsync; we do
    // NOT fail the write over this (see plan assumption: degrade, don't fail).
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Rotate `<file>.bak.(N-1) -> .bak.N`, then current target -> `.bak.1`. */
function rotateBackups(filePath: string, keep: number): void {
  if (keep <= 0) return;
  if (!fs.existsSync(filePath)) return; // nothing to back up on first write
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${filePath}.bak.${i}`;
    const to = `${filePath}.bak.${i + 1}`;
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }
  fs.copyFileSync(filePath, `${filePath}.bak.1`);
}

/**
 * Atomically write `data` to `filePath`. See module docs for the full sequence.
 */
export function safeWriteFile(
  filePath: string,
  data: string | Buffer,
  opts: SafeWriteOpts = {},
): void {
  const doFsync = opts.fsync !== false;
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, "w", opts.mode ?? 0o666);
    if (typeof data === "string") {
      fs.writeSync(fd, data);
    } else {
      fs.writeSync(fd, data, 0, data.length);
    }
    if (doFsync) fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    rotateBackups(filePath, opts.backups ?? 0);
    fs.renameSync(tmpPath, filePath);
    if (doFsync) fsyncDir(dir);
    if (opts.mode !== undefined) fs.chmodSync(filePath, opts.mode);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    throw err;
  } finally {
    // Remove the tmp on any path where it survived (thrown validate upstream
    // never gets here; thrown write/rename leaves a tmp we must clean).
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }

  if (opts.audit) {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    appendAudit({
      actor: opts.audit.actor,
      file: filePath,
      checksum: sha256Hex(bytes),
      op: opts.audit.op,
      auditLogPath: opts.audit.auditLogPath,
    });
  }
}

export interface SafeWriteJsonOpts extends SafeWriteOpts {
  /** Throws BEFORE any tmp is created if the value is invalid (zod parse, guard, …). */
  validate?: (value: unknown) => void;
  /** JSON.stringify indentation. Default 2. */
  space?: number;
}

export function safeWriteJson(filePath: string, value: unknown, opts: SafeWriteJsonOpts = {}): void {
  if (opts.validate) opts.validate(value);
  safeWriteFile(filePath, JSON.stringify(value, null, opts.space ?? 2), opts);
}

export interface SafeWriteYamlOpts extends SafeWriteOpts {
  validate?: (value: unknown) => void;
  dumpOptions?: yaml.DumpOptions;
}

export function safeWriteYaml(filePath: string, value: unknown, opts: SafeWriteYamlOpts = {}): void {
  if (opts.validate) opts.validate(value);
  safeWriteFile(filePath, yaml.dump(value, opts.dumpOptions), opts);
}

export function safeWriteText(filePath: string, text: string, opts: SafeWriteOpts = {}): void {
  safeWriteFile(filePath, text, opts);
}
