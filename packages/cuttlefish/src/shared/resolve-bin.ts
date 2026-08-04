import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

/**
 * Dynamic engine-binary resolution.
 *
 * Cuttlefish ships to other users' machines, so engine binaries must NEVER be
 * hardcoded to an absolute path. We resolve a binary the same way a shell
 * would (search PATH), plus a few common install dirs that aren't always on
 * a daemon's PATH (notably `~/.local/bin`, where the Antigravity installer
 * drops `agy`). An optional config override (`engines.<name>.bin`) wins.
 */

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    // X_OK is meaningless on Windows (access() treats it as "exists");
    // executability there is conveyed by the extension instead — see
    // executableCandidates().
    if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Filenames to probe for `name` inside one directory. POSIX: the name itself.
 * Windows: the PATHEXT extensions, in PATHEXT order (so `codex.exe` wins over
 * `codex.cmd`, matching cmd.exe's own resolution) — npm installs CLIs there as
 * extension-less shims plus `.cmd`/`.ps1` wrappers, and only the extension
 * variants are spawnable.
 */
export function executableCandidates(name: string, pathext: string | undefined = process.env.PATHEXT): string[] {
  if (process.platform !== "win32") return [name];
  const exts = (pathext || DEFAULT_PATHEXT).split(";").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (exts.some((ext) => name.toLowerCase().endsWith(ext))) return [name];
  // Lowercased: Windows filesystems are case-insensitive and npm writes
  // lowercase shims (claude.cmd), so this stays correct there and exact for
  // the case-sensitive filesystems the tests run on.
  return exts.map((ext) => name + ext);
}

/** Common install locations not guaranteed to be on a daemon's PATH. */
export function commonBinDirs(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const env = process.env;
    return [
      ...(env.APPDATA ? [path.join(env.APPDATA, "npm")] : []), // npm global shims
      ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "pnpm")] : []), // pnpm global shims
      path.join(home, ".local", "bin"),
      path.join(home, "bin"),
    ];
  }
  return [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(home, "bin"),
    path.join(home, ".npm-global", "bin"), // npm global prefix (common override)
    "/opt/homebrew/lib/node_modules/.bin", // homebrew node global bins
  ];
}

/**
 * Resolve an engine binary to an absolute path.
 *
 * Resolution order:
 *   1. `override` that looks like a path (contains a separator) → returned
 *      verbatim, even if missing, so a wrong config surfaces a clear spawn error.
 *   2. `override` that is a bare name → resolved as if it were `name`.
 *   3. First match on `$PATH`.
 *   4. First match in {@link commonBinDirs}.
 *   5. Fallback: the bare `name`, letting `spawn`/`pty.spawn` try its own PATH.
 */
/** First executable match for `name` on PATH then {@link commonBinDirs}, or null. */
function findOnPath(name: string): string | null {
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const seen = new Set<string>();
  for (const dir of [...pathDirs, ...commonBinDirs()]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const filename of executableCandidates(name)) {
      const candidate = path.join(dir, filename);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveBin(name: string, override?: string): string {
  if (override && override.trim()) {
    const o = override.trim();
    if (o.includes("/") || o.includes(path.sep)) {
      return o; // explicit path — honor it as-is
    }
    name = o; // bare-name override → resolve that name instead
  }

  return findOnPath(name) ?? name; // fallback: bare name, let spawn try its own PATH
}

/**
 * Whether an engine CLI is available for Cuttlefish to invoke.
 *
 * Unlike {@link resolveBin} — which returns the bare name as a fallback so a
 * spawn surfaces a clear error — this returns a boolean, so the registry can gate
 * an engine's visibility on a usable CLI. An explicit-path override must point
 * at an existing executable, and the resolved binary must complete a bounded
 * `--version` probe. This rejects stale launchers that still have an executable
 * bit but can no longer start their underlying CLI.
 *
 * A successful probe deliberately does not assert account authentication or
 * available quota; those are provider-side checks that happen when the engine
 * is used.
 */
export function isInstalled(name: string, override?: string): boolean {
  let bin: string | null = null;
  if (override && override.trim()) {
    const o = override.trim();
    if (o.includes("/") || o.includes(path.sep)) {
      bin = isExecutableFile(o) ? o : null;
    } else {
      name = o;
    }
  }
  bin ??= findOnPath(name);
  if (!bin) return false;

  try {
    // Windows .cmd/.bat launchers cannot be spawned directly (Node rejects
    // them with EINVAL); route the probe through cmd.exe with the path quoted
    // so spaces in the install dir survive.
    const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    execFileSync(viaShell ? `"${bin}"` : bin, ["--version"], {
      stdio: "ignore",
      timeout: 2_000,
      windowsHide: true,
      ...(viaShell ? { shell: true } : {}),
    });
    return true;
  } catch {
    return false;
  }
}
