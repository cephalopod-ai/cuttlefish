import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executableCandidates, isInstalled, resolveBin } from "../resolve-bin.js";

// POSIX-host resolution semantics (extension-less executables, chmod bits) —
// meaningless on a real Windows host, where the Windows describe below runs
// against the genuine platform instead of a mock.
describe.skipIf(process.platform === "win32")("resolveBin", () => {
  let tmpDir: string;
  let exePath: string;
  const NAME = "cuttlefish-fake-engine-xyz";

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolvebin-"));
    exePath = path.join(tmpDir, NAME);
    fs.writeFileSync(exePath, "#!/bin/sh\necho hi\n");
    fs.chmodSync(exePath, 0o755);
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("honors an absolute-path override verbatim", () => {
    expect(resolveBin("agy", exePath)).toBe(exePath);
  });

  it("honors an explicit path override even if it does not exist yet (so spawn surfaces a clear error)", () => {
    const missing = path.join(tmpDir, "does", "not", "exist");
    expect(resolveBin("agy", missing)).toBe(missing);
  });

  it("finds an executable on PATH", () => {
    const prev = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${prev ?? ""}`;
    try {
      expect(resolveBin(NAME)).toBe(exePath);
    } finally {
      process.env.PATH = prev;
    }
  });

  it("treats a bare-name override as the name to resolve", () => {
    const prev = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${prev ?? ""}`;
    try {
      // resolve "agy" but override tells it to look for our fake name instead
      expect(resolveBin("agy", NAME)).toBe(exePath);
    } finally {
      process.env.PATH = prev;
    }
  });

  it("falls back to the bare name when nothing is found (spawn will try its own PATH)", () => {
    const prev = process.env.PATH;
    process.env.PATH = ""; // nothing on PATH
    try {
      // Use a name that won't exist in the hardcoded common dirs either.
      expect(resolveBin("definitely-not-a-real-binary-zzz")).toBe("definitely-not-a-real-binary-zzz");
    } finally {
      process.env.PATH = prev;
    }
  });

  it("ignores a blank override", () => {
    const prev = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${prev ?? ""}`;
    try {
      expect(resolveBin(NAME, "   ")).toBe(exePath);
    } finally {
      process.env.PATH = prev;
    }
  });

  it("requires a resolved executable to complete the bounded version probe", () => {
    const broken = path.join(tmpDir, "cuttlefish-broken-engine-xyz");
    fs.writeFileSync(broken, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(broken, 0o755);

    expect(isInstalled("agy", exePath)).toBe(true);
    expect(isInstalled("agy", broken)).toBe(false);
  });

  it("reuses probes across repeated worker checks but refreshes changed launchers and expired results", () => {
    const engine = path.join(tmpDir, "counted-engine");
    const count = path.join(tmpDir, "probe-count");
    fs.writeFileSync(engine, `#!/bin/sh\necho probe >> '${count}'\nexit 0\n`, { mode: 0o755 });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      for (let i = 0; i < 30; i++) expect(isInstalled("counted", engine)).toBe(true);
      expect(fs.readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
      clock.mockReturnValue(now + 30_001);
      expect(isInstalled("counted", engine)).toBe(true);
      expect(fs.readFileSync(count, "utf8").trim().split("\n")).toHaveLength(2);
      fs.writeFileSync(engine, "#!/bin/sh\n# changed launcher\nexit 1\n");
      expect(isInstalled("counted", engine)).toBe(false);
      fs.unlinkSync(engine);
      expect(isInstalled("counted", engine)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not substitute a PATH installation for an unusable explicit override", () => {
    const prev = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${prev ?? ""}`;
    const nonExecutable = path.join(tmpDir, "not-executable");
    fs.writeFileSync(nonExecutable, "#!/bin/sh\necho version\n", { mode: 0o644 });
    try {
      expect(isInstalled(NAME)).toBe(true);
      for (const override of [path.join(tmpDir, "missing"), nonExecutable, tmpDir]) {
        expect(resolveBin(NAME, override)).toBe(override);
        expect(isInstalled(NAME, override)).toBe(false);
      }
      expect(isInstalled(NAME, exePath)).toBe(true);
      expect(isInstalled("other-engine", NAME)).toBe(true);
      expect(isInstalled(NAME, "  ")).toBe(true);
    } finally {
      process.env.PATH = prev;
    }
  });
});

describe("resolveBin on Windows", () => {
  const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolvebin-win-"));
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", REAL_PLATFORM);
  });

  function asWindows(): void {
    Object.defineProperty(process, "platform", { value: "win32" });
  }

  it("probes PATHEXT extensions for a bare name (npm CLIs are .cmd shims)", () => {
    fs.writeFileSync(path.join(tmpDir, "win-fake-engine.cmd"), "@echo off\r\n");
    asWindows();
    const prev = process.env.PATH;
    process.env.PATH = tmpDir;
    try {
      expect(resolveBin("win-fake-engine")).toBe(path.join(tmpDir, "win-fake-engine.cmd"));
    } finally {
      process.env.PATH = prev;
    }
  });

  it("prefers .exe over .cmd, matching PATHEXT order", () => {
    fs.writeFileSync(path.join(tmpDir, "win-dual-engine.cmd"), "@echo off\r\n");
    fs.writeFileSync(path.join(tmpDir, "win-dual-engine.exe"), "MZ");
    asWindows();
    const prev = process.env.PATH;
    process.env.PATH = tmpDir;
    try {
      expect(resolveBin("win-dual-engine")).toBe(path.join(tmpDir, "win-dual-engine.exe"));
    } finally {
      process.env.PATH = prev;
    }
  });

  const onRealWindows = (REAL_PLATFORM.value as string) === "win32";

  /** On a POSIX host the cmd.exe-wrapped probe needs a stand-in comspec (a sh
   *  script with the given exit code); a real Windows host runs actual cmd.exe
   *  against the .cmd fixture, so comspec is left alone there. Returns a
   *  restore fn. */
  function comspecForProbe(exitCode: number): () => void {
    if (onRealWindows) return () => {};
    const fake = path.join(tmpDir, `fake-comspec-${exitCode}`);
    fs.writeFileSync(fake, `#!/bin/sh\nexit ${exitCode}\n`);
    fs.chmodSync(fake, 0o755);
    const prev = process.env.comspec;
    process.env.comspec = fake;
    return () => {
      if (prev === undefined) delete process.env.comspec;
      else process.env.comspec = prev;
    };
  }

  it("classifies a .cmd-shim-only install as installed when the cmd.exe probe succeeds", () => {
    fs.writeFileSync(path.join(tmpDir, "win-shim-only-engine.cmd"), "@echo off\r\nexit /b 0\r\n");
    const restoreComspec = comspecForProbe(0);
    asWindows();
    const prev = process.env.PATH;
    process.env.PATH = tmpDir;
    try {
      // npm i -g writes only shims (no .exe): the shim resolves AND counts as
      // installed — the probe and non-PTY runners route it through cmd.exe
      // (windows-exec), and PTY spawns launch it natively via ConPTY.
      expect(resolveBin("win-shim-only-engine")).toBe(path.join(tmpDir, "win-shim-only-engine.cmd"));
      expect(isInstalled("win-shim-only-engine")).toBe(true);
    } finally {
      process.env.PATH = prev;
      restoreComspec();
    }
  });

  it("keeps a shim-only install unavailable when the probe fails", () => {
    fs.writeFileSync(path.join(tmpDir, "win-broken-shim-engine.cmd"), "@echo off\r\nexit /b 1\r\n");
    const restoreComspec = comspecForProbe(1);
    asWindows();
    const prev = process.env.PATH;
    process.env.PATH = tmpDir;
    try {
      expect(isInstalled("win-broken-shim-engine")).toBe(false);
    } finally {
      process.env.PATH = prev;
      restoreComspec();
    }
  });

  it("uses a name that already carries an executable extension verbatim", () => {
    asWindows();
    expect(executableCandidates("claude.exe", undefined)).toEqual(["claude.exe"]);
    // Pin PATHEXT explicitly: on a real Windows host, `undefined` falls back to
    // the machine's own PATHEXT (which includes .VBS/.MSC/… on CI runners) and
    // the fallback-default expectation below would not hold.
    expect(executableCandidates("claude", ".COM;.EXE;.BAT;.CMD")).toEqual([
      "claude.com",
      "claude.exe",
      "claude.bat",
      "claude.cmd",
    ]);
  });

  it.skipIf(process.platform === "win32")("keeps POSIX candidates untouched off Windows", () => {
    expect(executableCandidates("claude", undefined)).toEqual(["claude"]);
  });
});
