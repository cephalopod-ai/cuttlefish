import fs from "node:fs";
import path from "node:path";
import { realpathDeepest } from "./safe-delete.js";

/**
 * Shared path-containment helper for resolving a caller-controlled relative
 * path under a trusted root, refusing any resolution that would escape it.
 *
 * Four independent, subtly different containment checks already exist in
 * this codebase (`safe-delete.ts#assertSafeDestructivePath`,
 * `orchestration/worktree.ts`'s private `isSameOrInside`/`assertInsideRoot`,
 * `gateway/content-screening.ts`'s private `isPathInsideRoot`, and
 * `gateway/fs-browse.ts`'s private `withinRoots`), each built for a
 * different call site and none directly reusable for a new one. New call
 * sites (starting with the orchestration validation runner) should use this
 * module instead of adding a fifth variant.
 *
 * Unlike `assertSafeDestructivePath` (which is delete-safety-shaped and
 * rejects a target equal to its own containment root), this defaults to
 * *allowing* the root itself as a valid target, since running a command with
 * its working directory set to the root it is contained in is the common
 * case this helper exists for.
 */

export class PathContainmentError extends Error {}

export interface ResolveContainedPathOptions {
  /** Allow the resolved path to equal the containment root itself. Default: true. */
  allowRootItself?: boolean;
  /** Allow the resolved path's final component to be a symlink. Default: false. */
  allowSymlink?: boolean;
  /** Human-readable label used in error messages. Default: "path". */
  label?: string;
}

/**
 * Resolve `relativePath` under `root` in the real-path domain (so a
 * symlinked intermediate directory cannot be used to escape containment),
 * and throw `PathContainmentError` unless the result is `root` itself
 * (unless disallowed) or a strict descendant of it.
 *
 * Returns the resolved path with symlinks resolved on its longest existing
 * prefix — not `fs.realpathSync`'s whole-path form, since the leaf itself
 * may not exist yet (e.g. a file a validation command is about to create).
 */
export function resolveContainedPath(
  root: string,
  relativePath: string | undefined,
  opts: ResolveContainedPathOptions = {},
): string {
  const label = opts.label ?? "path";
  const allowRootItself = opts.allowRootItself ?? true;

  if (typeof root !== "string" || root.trim() === "") {
    throw new PathContainmentError(`${label}: containment root is empty`);
  }
  const candidate = typeof relativePath === "string" && relativePath.trim() !== ""
    ? path.resolve(root, relativePath)
    : path.resolve(root);

  const realRoot = realpathDeepest(root);
  const parent = path.dirname(candidate);
  const realCandidate = parent === candidate ? candidate : path.join(realpathDeepest(parent), path.basename(candidate));

  if (realCandidate === realRoot) {
    if (!allowRootItself) {
      throw new PathContainmentError(`${label} resolves to its containment root and is not allowed here: ${candidate}`);
    }
  } else if (!realCandidate.startsWith(realRoot + path.sep)) {
    throw new PathContainmentError(`${label} escapes its containment root ${realRoot}: ${candidate}`);
  }

  if (!opts.allowSymlink) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(realCandidate);
    } catch {
      stat = undefined; // nonexistent target is fine — caller may be about to create it
    }
    if (stat?.isSymbolicLink()) {
      throw new PathContainmentError(`${label} is a symlink and is not allowed here: ${realCandidate}`);
    }
  }

  return realCandidate;
}
