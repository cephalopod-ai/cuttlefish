import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Safe-delete / destructive-path guard.
 *
 * One shared assertion that every recursive/forceful `fs.rmSync` in the daemon
 * should funnel through, replacing the ad-hoc guards that grew up independently
 * (`assertSafeDestructiveHome` in cli/instances, `assertInsideRoot` in
 * orchestration/worktree, `isServablePath` in gateway/files). Static audits
 * (Fissure FTRIAGE-001–008) flagged the unguarded `rmSync(..., {recursive,force})`
 * sites because nothing proved the target could not resolve to a
 * catastrophic path (`/`, `~`, cwd) or escape its intended directory.
 *
 * `assertSafeDestructivePath` rejects, before any bytes are removed:
 *   1. an empty / non-string target,
 *   2. the filesystem root,
 *   3. the user home directory,
 *   4. the current working directory,
 *   5. (when `within` is given) any path not strictly contained in that base,
 *   6. a symlinked target (so deletion follows the link's own inode, never its
 *      destination).
 *
 * Containment is purely lexical (`path.resolve` on both sides, no `realpath`) so
 * that a target created under the lexical `os.tmpdir()` is not falsely rejected
 * when tmp itself is a symlink (e.g. macOS `/tmp` -> `/private/tmp`). The
 * dedicated symlink check on the final component closes the escape that
 * lexical containment alone would miss.
 *
 * Synchronous by design to stay a drop-in guard in front of the existing sync
 * `rmSync` callers.
 */

export interface SafeDestructiveOptions {
  /** Human-readable label used in error messages. Default: "path". */
  label?: string;
  /**
   * If set, the resolved target must be strictly contained within this base
   * directory (and may not equal it). Compared lexically — pass the same base
   * string the target was constructed from.
   */
  within?: string;
  /** Allow the target itself to be a symlink. Default: false. */
  allowSymlink?: boolean;
}

/**
 * Validate that `target` is safe to recursively/forcefully delete. Returns the
 * resolved absolute path, or throws with a message describing the violation.
 */
export function assertSafeDestructivePath(target: string, opts: SafeDestructiveOptions = {}): string {
  const label = opts.label ?? "path";
  if (typeof target !== "string" || target.trim() === "") {
    throw new Error(`${label} is empty and will not be deleted`);
  }

  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const userHome = path.resolve(os.homedir());

  if (resolved === root) {
    throw new Error(`${label} resolves to filesystem root: ${resolved}`);
  }
  if (resolved === userHome) {
    throw new Error(`${label} resolves to the user home directory: ${resolved}`);
  }
  if (resolved === path.resolve(process.cwd())) {
    throw new Error(`${label} resolves to the current working directory: ${resolved}`);
  }

  if (opts.within !== undefined) {
    // Compare in the real-path domain: resolve symlinks on the existing prefix of
    // BOTH the base and the target's parent chain. This catches a symlinked
    // intermediate directory that lexical containment would miss, while a base
    // reached through a symlink (e.g. macOS /tmp -> /private/tmp) is still
    // accepted because both sides resolve the same way. The final component is
    // kept lexical so a symlinked leaf is rejected by the lstat check below
    // (and deleted as the link, never followed).
    const realBase = realpathDeepest(opts.within);
    const parent = path.dirname(resolved);
    const realTarget = parent === resolved ? resolved : path.join(realpathDeepest(parent), path.basename(resolved));
    if (realTarget === realBase) {
      throw new Error(`${label} resolves to its containment root and will not be deleted: ${resolved}`);
    }
    if (!realTarget.startsWith(realBase + path.sep)) {
      throw new Error(`${label} is outside its managed root ${realBase}: ${resolved}`);
    }
  }

  if (!opts.allowSymlink) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      // Nonexistent target: deletion is a no-op, so there is nothing to guard.
      stat = undefined;
    }
    if (stat?.isSymbolicLink()) {
      throw new Error(`${label} is a symlink and will not be deleted: ${resolved}`);
    }
  }

  return resolved;
}

/**
 * Resolve symlinks on the longest existing prefix of `p`, then re-append any
 * not-yet-existing tail lexically. Unlike `fs.realpathSync` this does not throw
 * when the target itself is absent (deletion of a missing path is a no-op), so
 * containment can still be checked in the real-path domain.
 */
function realpathDeepest(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    if (fs.existsSync(cur)) {
      let real: string;
      try {
        real = fs.realpathSync(cur);
      } catch {
        real = cur;
      }
      return tail.length ? path.join(real, ...tail) : real;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p); // no existing ancestor (should not happen)
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}

export interface SafeRmOptions extends SafeDestructiveOptions {
  /** Pass `recursive` through to `fs.rmSync`. Default true. */
  recursive?: boolean;
}

/**
 * Assert `target` is safe (via {@link assertSafeDestructivePath}) then remove it
 * with `force: true`. Returns `false` if the path was already absent. `force`
 * stays on so a TOCTOU disappearance between the check and the unlink does not
 * throw.
 */
export function safeRmSync(target: string, opts: SafeRmOptions = {}): boolean {
  const resolved = assertSafeDestructivePath(target, opts);
  if (!fs.existsSync(resolved)) return false;
  fs.rmSync(resolved, { force: true, recursive: opts.recursive ?? true });
  return true;
}
