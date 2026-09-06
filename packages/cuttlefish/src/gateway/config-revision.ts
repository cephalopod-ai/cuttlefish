import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import { CONFIG_PATH } from "../shared/paths.js";

/**
 * UPS-A7: `PUT /api/config` merges into whatever `config.yaml` holds at the
 * moment it runs. A Settings page opened before somebody edited the file at a
 * terminal therefore saves its own stale view straight over that edit, with no
 * error and nothing in the log — and `config.yaml` is where auth, file-read
 * roots and connector policy live, so a silent revert there is a security
 * regression channel, not only an annoyance.
 *
 * The fix is an optimistic-concurrency token. `GET /api/config` stamps a
 * revision; a `PUT` that carries an older one is refused before the merge and
 * before the write.
 *
 * The revision is taken over the *file's bytes*, not the in-memory config,
 * because the file is what the merge reads and therefore what a conflict is
 * actually about.
 */

export const CONFIG_REVISION_HEADER = "X-Cuttlefish-Config-Revision";
const CONFIG_REVISION_HEADER_LC = CONFIG_REVISION_HEADER.toLowerCase();

/** Revision reported when no config file exists yet. A PUT holding this that
 *  finds a file on disk is stale in exactly the way a hash mismatch is. */
export const ABSENT_CONFIG_REVISION = "absent";

export function currentConfigRevision(configPath: string = CONFIG_PATH): string {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(configPath)).digest("hex");
  } catch {
    return ABSENT_CONFIG_REVISION;
  }
}

/** The revision a request claims to have seen, or undefined when it sent none. */
export function requestedConfigRevision(headers: IncomingMessage["headers"]): string | undefined {
  const raw = headers[CONFIG_REVISION_HEADER_LC];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export interface ConfigRevisionCheck {
  /** The revision on disk right now — handed back either way, so a conflicted
   *  page can adopt it without a second round trip. */
  current: string;
  conflict: boolean;
}

/**
 * Decide whether a write may proceed.
 *
 * A request that sends no revision behaves exactly as it always did. That is
 * deliberate: it is the opt-out for a caller performing a partial merge into a
 * document it never read, which has nothing to clobber.
 */
export function checkConfigRevision(
  headers: IncomingMessage["headers"],
  configPath: string = CONFIG_PATH,
): ConfigRevisionCheck {
  const current = currentConfigRevision(configPath);
  const claimed = requestedConfigRevision(headers);
  return { current, conflict: claimed !== undefined && claimed !== current };
}
