import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Directory browser backing the new-chat folder picker (Feature: per-chat
 * working folder). Directories only — the picker selects a folder, never a file.
 *
 * Security model (see validateCwd): realpath-resolve so `..`/symlink tricks
 * cannot escape, optional `roots` allow-list. With no roots configured this is
 * free-browse — appropriate for the single-user loopback default; operators who
 * front the gateway over SSO/remote should set `workspaces.roots` to lock it down.
 * Never logs or echoes paths into query strings.
 */

export class FsBrowseError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "FsBrowseError";
  }
}

export interface FsEntry {
  name: string;
  isDir: true;
}
export interface FsListResult {
  /** Realpath-resolved absolute directory being listed. */
  path: string;
  /** Parent directory, or null when at a root boundary (filesystem root or an allow-root). */
  parent: string | null;
  entries: FsEntry[];
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function realRoots(roots?: string[]): string[] {
  return (roots ?? [])
    .filter((r) => typeof r === "string" && r.trim() !== "")
    .map((r) => {
      try {
        return fs.realpathSync(path.resolve(expandTilde(r)));
      } catch {
        return path.resolve(expandTilde(r));
      }
    });
}

/** True when `resolved` is inside (or equal to) any allowed root. No roots = allow all. */
function withinRoots(resolved: string, roots: string[]): boolean {
  if (roots.length === 0) return true;
  return roots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
}

/**
 * List the subdirectories of `requested` (defaults to `defaultDir`). Throws
 * FsBrowseError (mapped to 400/403 by the caller) on a missing/non-dir/out-of-
 * bounds path — never a silent fallback.
 */
export function listDirectory(
  requested: string | undefined,
  opts: { roots?: string[]; defaultDir: string },
): FsListResult {
  const target = requested && requested.trim() !== "" ? requested : opts.defaultDir;
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(expandTilde(target)));
  } catch {
    throw new FsBrowseError(`path does not exist: ${target}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new FsBrowseError(`path not accessible: ${target}`);
  }
  if (!stat.isDirectory()) throw new FsBrowseError(`not a directory: ${target}`);

  const roots = realRoots(opts.roots);
  if (!withinRoots(resolved, roots)) throw new FsBrowseError(`path is outside allowed roots`, 403);

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    throw new FsBrowseError(`cannot read directory: ${target}`, 403);
  }

  const entries: FsEntry[] = dirents
    .filter((d) => {
      if (d.name.startsWith(".")) return false; // hide dotdirs by default
      if (d.isDirectory()) return true;
      if (d.isSymbolicLink()) {
        try {
          return fs.statSync(path.join(resolved, d.name)).isDirectory();
        } catch {
          return false;
        }
      }
      return false;
    })
    .map((d) => ({ name: d.name, isDir: true as const }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parentRaw = path.dirname(resolved);
  const parent = parentRaw !== resolved && withinRoots(parentRaw, roots) ? parentRaw : null;

  return { path: resolved, parent, entries };
}
