import path from "node:path";
import {
  spawn,
  spawnSync,
  execFile,
  execFileSync,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileException,
  type ExecFileOptions,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnOptions,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Windows spawn compatibility.
 *
 * npm installs CLIs on Windows as `.cmd`/`.bat` shims (plus an extension-less
 * sh script), not `.exe` binaries. Node's shell-less `child_process.spawn`/
 * `execFile` reject `.cmd`/`.bat` with EINVAL (CVE-2024-27980 hardening), so
 * every non-PTY engine spawn must route shims through `cmd.exe /d /s /c`
 * instead. The command line handed to cmd.exe is caret-escaped exactly like
 * cross-spawn does it — engine args carry user prompt text, so this escaping
 * is a security boundary, not a convenience. PTY spawns (node-pty/ConPTY)
 * launch shims natively and do not go through this module.
 *
 * On POSIX every helper here is a byte-for-byte passthrough to
 * node:child_process — macOS/Linux behavior is unchanged by construction.
 */

/** cmd.exe metacharacters, caret-escaped by the cross-spawn algorithm. */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** True when `bin` is a cmd.exe shim that a shell-less spawn would reject. */
export function isWindowsShim(bin: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}

/** Caret-escape a command path for a cmd.exe command line (no quote-wrapping). */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

/**
 * Escape one argument for a cmd.exe command line: double backslashes before
 * quotes and at the end, quote-wrap, then caret-escape every metacharacter
 * (the wrapping quotes included). `.cmd`/`.bat` targets re-parse the line, so
 * they need the metacharacters escaped twice.
 */
export function escapeCmdArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  let s = String(arg);
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, "$1$1");
  s = `"${s}"`;
  s = s.replace(CMD_META_CHARS, "^$1");
  if (doubleEscapeMetaChars) s = s.replace(CMD_META_CHARS, "^$1");
  return s;
}

export interface SpawnableCommand {
  file: string;
  args: string[];
  /** Must be forwarded to the spawn options when true — the args are a
   *  pre-escaped cmd.exe line that Node must not re-quote. */
  windowsVerbatimArguments: boolean;
}

/**
 * Rewrite a (file, args) pair so it is spawnable: `.cmd`/`.bat` shims become a
 * `cmd.exe /d /s /c "<escaped line>"` invocation; everything else (all of
 * POSIX included) passes through untouched.
 */
export function wrapCommand(file: string, args: readonly string[]): SpawnableCommand {
  if (!isWindowsShim(file)) {
    return { file, args: [...args], windowsVerbatimArguments: false };
  }
  const line = [
    escapeCmdCommand(path.normalize(file)),
    ...args.map((a) => escapeCmdArgument(a, true)),
  ].join(" ");
  return {
    file: process.env.comspec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

function withVerbatim<T extends object>(cmd: SpawnableCommand, options: T | undefined): T | undefined {
  if (!cmd.windowsVerbatimArguments) return options;
  return { ...(options ?? {}), windowsVerbatimArguments: true } as T;
}

/** `child_process.spawn` that can launch Windows `.cmd`/`.bat` shims. The
 *  stdio-tuple overloads mirror node:child_process so callers keep typed
 *  (non-null) streams. */
export function spawnCompat(
  file: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>,
): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnCompat(
  file: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnCompat(
  file: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioNull>,
): ChildProcessByStdio<Writable, Readable, null>;
export function spawnCompat(file: string, args: readonly string[], options: SpawnOptions): ChildProcess;
export function spawnCompat(file: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const cmd = wrapCommand(file, args);
  return spawn(cmd.file, cmd.args, withVerbatim(cmd, options) ?? options);
}

/** Callback-style `child_process.execFile` that can launch Windows shims. */
export function execFileCompat(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): ChildProcess {
  const cmd = wrapCommand(file, args);
  const merged = cmd.windowsVerbatimArguments ? { ...options, windowsVerbatimArguments: true } : options;
  return execFile(cmd.file, cmd.args, merged, (error, stdout, stderr) => {
    callback(
      error,
      typeof stdout === "string" ? stdout : stdout.toString("utf8"),
      typeof stderr === "string" ? stderr : stderr.toString("utf8"),
    );
  });
}

/** `child_process.execFileSync` that can launch Windows shims. */
export function execFileSyncCompat(
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function execFileSyncCompat(file: string, args: readonly string[], options?: ExecFileSyncOptions): Buffer;
export function execFileSyncCompat(
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptions,
): string | Buffer {
  const cmd = wrapCommand(file, args);
  return execFileSync(cmd.file, cmd.args, withVerbatim(cmd, options));
}

/**
 * Terminate a process AND its descendants.
 *
 * POSIX: signal the process group (the engines spawn with `detached: true`,
 * which makes the child a group leader), falling back to the single PID when
 * no group exists. Windows: `taskkill /T /F` — outbound signals are
 * TerminateProcess there anyway (no cooperative delivery), and a plain
 * `proc.kill()` reaches only the immediate child, orphaning any grandchildren
 * an engine CLI forked.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    process.kill(pid, signal); // no group (ESRCH on -pid) — at least kill the child
  }
}
