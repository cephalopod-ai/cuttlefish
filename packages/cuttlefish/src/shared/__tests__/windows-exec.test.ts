import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  escapeCmdArgument,
  escapeCmdCommand,
  execFileCompat,
  isWindowsShim,
  killProcessTree,
  wrapCommand,
} from "../windows-exec.js";

const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;

function asWindows(): void {
  Object.defineProperty(process, "platform", { value: "win32" });
}

afterEach(() => {
  Object.defineProperty(process, "platform", REAL_PLATFORM);
});

describe("isWindowsShim", () => {
  it.skipIf(process.platform === "win32")("is false everywhere off Windows, shim extension or not", () => {
    expect(isWindowsShim("claude.cmd")).toBe(false);
    expect(isWindowsShim("claude")).toBe(false);
  });

  it("matches .cmd/.bat case-insensitively on Windows only", () => {
    asWindows();
    expect(isWindowsShim("C:\\npm\\claude.cmd")).toBe(true);
    expect(isWindowsShim("C:\\npm\\claude.CMD")).toBe(true);
    expect(isWindowsShim("C:\\npm\\legacy.bat")).toBe(true);
    expect(isWindowsShim("C:\\npm\\claude.exe")).toBe(false);
    expect(isWindowsShim("claude")).toBe(false);
  });
});

describe("cmd.exe escaping (cross-spawn algorithm)", () => {
  it("quote-wraps and caret-escapes a plain argument", () => {
    expect(escapeCmdArgument("foo", false)).toBe('^"foo^"');
  });

  it("caret-escapes shell metacharacters so injection cannot break out", () => {
    const escaped = escapeCmdArgument("a & del /q *", false);
    expect(escaped).toBe('^"a^ ^&^ del^ /q^ ^*^"');
    // The dangerous chars never appear unescaped.
    expect(escaped).not.toMatch(/[^^]&/);
  });

  it("double-escapes metacharacters for .cmd/.bat targets (line is parsed twice)", () => {
    expect(escapeCmdArgument("hello world", true)).toBe('^^^"hello^^^ world^^^"');
  });

  it("escapes embedded quotes and trailing backslashes", () => {
    expect(escapeCmdArgument('say "hi"', false)).toBe('^"say^ \\^"hi\\^"^"');
    expect(escapeCmdArgument("trail\\", false)).toBe('^"trail\\\\^"');
  });

  it("caret-escapes metacharacters in a command path without quoting it", () => {
    expect(escapeCmdCommand("C:\\Program Files\\claude.cmd")).toBe("C:\\Program^ Files\\claude.cmd");
    expect(escapeCmdCommand("C:\\npm\\claude.cmd")).toBe("C:\\npm\\claude.cmd");
  });
});

describe("wrapCommand", () => {
  it.skipIf(process.platform === "win32")("passes everything through untouched off Windows", () => {
    const cmd = wrapCommand("claude.cmd", ["--version"]);
    expect(cmd).toEqual({ file: "claude.cmd", args: ["--version"], windowsVerbatimArguments: false });
  });

  it("passes native executables through untouched on Windows", () => {
    asWindows();
    const cmd = wrapCommand("C:\\tools\\codex.exe", ["--version"]);
    expect(cmd.file).toBe("C:\\tools\\codex.exe");
    expect(cmd.args).toEqual(["--version"]);
    expect(cmd.windowsVerbatimArguments).toBe(false);
  });

  it("rewrites a .cmd shim to a cmd.exe /d /s /c invocation", () => {
    asWindows();
    const shim = "C:\\npm\\claude.cmd";
    const cmd = wrapCommand(shim, ["--version"]);
    expect(cmd.file).toBe(process.env.comspec || "cmd.exe");
    expect(cmd.windowsVerbatimArguments).toBe(true);
    expect(cmd.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(cmd.args[3]).toBe(`"${shim} ^^^"--version^^^""`);
  });

  it("keeps user prompt text inert inside the cmd.exe line", () => {
    asWindows();
    const cmd = wrapCommand("C:\\npm\\kilo.cmd", ["run", "ignore this & echo pwned"]);
    const line = cmd.args[3];
    // Every & in the line is caret-escaped; nothing can terminate the command.
    expect(line).not.toMatch(/[^^]&/);
    expect(line).toContain("^^^ ^^^&^^^ ");
  });
});

describe("execFileCompat shim timeout (Windows)", () => {
  // Runs only on the windows CI job: exercises the taken-over timeout that
  // tree-kills a hung shim while the cmd.exe wrapper is still alive.
  it.skipIf(process.platform !== "win32")("kills the whole shim tree when the timeout fires", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "winexec-timeout-"));
    const shim = path.join(tmp, "hang.cmd");
    fs.writeFileSync(shim, "@echo off\r\nping -n 30 127.0.0.1 >nul\r\n");
    const start = Date.now();
    try {
      await new Promise<void>((resolve) => {
        execFileCompat(shim, [], { timeout: 500 }, () => resolve());
      });
      expect(Date.now() - start).toBeLessThan(15_000);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("killProcessTree (POSIX)", () => {
  it.skipIf(process.platform === "win32")("terminates a detached child by process group", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.pid).toBeTruthy();
    killProcessTree(child.pid!, "SIGTERM");
    await exited;
    expect(child.exitCode === null || child.signalCode === "SIGTERM").toBe(true);
  });
});
