import fs from "node:fs";
import { logger } from "./logger.js";

export function isSqliteCorruptionError(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("database disk image is malformed") ||
    msg.includes("corrupt") ||
    msg.includes("SQLITE_CORRUPT") ||
    msg.includes("file is not a database")
  );
}

export function quarantineCorruptDb(dbPath: string, label = "sessions"): void {
  const backup = `${dbPath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(dbPath, backup);
  } catch {
    // If rename fails the path may already be gone; proceed.
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      const side = `${dbPath}${suffix}`;
      if (fs.existsSync(side)) fs.unlinkSync(side);
    } catch {
      // Best-effort cleanup of WAL/shm files.
    }
  }
  logger.warn(`Quarantined corrupt ${label} DB to ${backup} — starting fresh`);
}
