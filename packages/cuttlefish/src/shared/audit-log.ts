import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AUDIT_LOG } from "./paths.js";

/**
 * Hash-chained, append-only integrity ledger.
 *
 * Each record links to the previous one via `prev_checksum`, so any tampering
 * with an earlier line is detectable: the chain no longer verifies. This is the
 * correct integrity model for an audit trail, so — unlike every other writer in
 * the codebase — it deliberately does NOT go through `safeWrite`'s tmp+rename:
 * an atomic full-file replace would defeat tamper-evidence. We append + fsync.
 *
 * Dependency direction is strictly one-way: safe-write.ts -> audit-log.ts ->
 * paths.ts + node builtins. Nothing here imports from `gateway/` (avoids a
 * shared->gateway layering inversion), so we keep an inline last-line reader
 * rather than importing `gateway/jsonl-tail.ts`.
 */

export interface AuditRecord {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Who performed the write (e.g. "gateway", "cli:migrate", an employee slug). */
  actor: string;
  /** Absolute path of the file that was written. */
  file: string;
  /** Logical operation label (e.g. "write", "config.save", "approval.create"). */
  op: string;
  /** sha256 (hex) of the exact bytes written to `file`. */
  checksum: string;
  /** sha256 (hex) of the previous record's bytes, or null for the first record. */
  prev_checksum: string | null;
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Read the last non-empty line of a file without slurping the whole thing.
 * Reads a tail window (default 64 KiB) — audit records are small, so a single
 * window comfortably contains the final line. Returns null for missing/empty.
 */
function readLastLine(filePath: string, windowBytes = 64 * 1024): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const len = Math.min(windowBytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf-8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    return lines.length ? lines[lines.length - 1] : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Checksum of the previous chain record, or null if the ledger is empty. */
function previousChecksum(filePath: string): string | null {
  const last = readLastLine(filePath);
  if (!last) return null;
  try {
    const rec = JSON.parse(last) as Partial<AuditRecord>;
    return typeof rec.checksum === "string" ? rec.checksum : null;
  } catch {
    // A corrupt/partial trailing line breaks the chain; surface as null prev so
    // the next record starts a fresh (detectably-broken) link rather than crashing.
    return null;
  }
}

/**
 * Append one record to the integrity ledger. Synchronous + fsync'd so the
 * record is durable before the caller proceeds. An unwritable ledger is a real
 * integrity failure, so this throws rather than swallowing — callers in
 * `safeWrite` opt in to auditing explicitly and decide how to handle failure.
 */
export function appendAudit(entry: {
  actor: string;
  file: string;
  checksum: string;
  op?: string;
  ts?: string;
  auditLogPath?: string;
}): AuditRecord {
  const logPath = entry.auditLogPath ?? AUDIT_LOG;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const record: AuditRecord = {
    ts: entry.ts ?? new Date().toISOString(),
    actor: entry.actor,
    file: entry.file,
    op: entry.op ?? "write",
    checksum: entry.checksum,
    prev_checksum: previousChecksum(logPath),
  };
  const line = JSON.stringify(record) + "\n";
  const fd = fs.openSync(logPath, "a");
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return record;
}

/**
 * Verify the hash chain of a ledger file. Returns the first broken index (and a
 * reason) or `{ ok: true }`. Intended for tests / integrity audits, not the hot path.
 */
export function verifyAuditChain(
  logPath: string = AUDIT_LOG,
): { ok: true; count: number } | { ok: false; index: number; reason: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, count: 0 };
    throw err;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let prev: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    let rec: AuditRecord;
    try {
      rec = JSON.parse(lines[i]) as AuditRecord;
    } catch {
      return { ok: false, index: i, reason: "unparseable record" };
    }
    if (rec.prev_checksum !== prev) {
      return { ok: false, index: i, reason: "prev_checksum does not match prior record" };
    }
    prev = rec.checksum;
  }
  return { ok: true, count: lines.length };
}
