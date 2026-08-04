import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executableCandidates, isInstalled, resolveBin } from "../resolve-bin.js";

describe("resolveBin", () => {
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

  it("resolves a .cmd shim for spawning but does not classify it as installed", () => {
    fs.writeFileSync(path.join(tmpDir, "win-shim-only-engine.cmd"), "@echo off\r\n");
    asWindows();
    const prev = process.env.PATH;
    process.env.PATH = tmpDir;
    try {
      // resolveBin still surfaces the shim (PTY spawns and error messages can
      // use it), but the registry must not advertise the engine: the non-PTY
      // runners spawn shell-less and Node rejects .cmd/.bat with EINVAL.
      expect(resolveBin("win-shim-only-engine")).toBe(path.join(tmpDir, "win-shim-only-engine.cmd"));
      expect(isInstalled("win-shim-only-engine")).toBe(false);
    } finally {
      process.env.PATH = prev;
    }
  });

  it("uses a name that already carries an executable extension verbatim", () => {
    asWindows();
    expect(executableCandidates("claude.exe", undefined)).toEqual(["claude.exe"]);
    expect(executableCandidates("claude", undefined)).toEqual([
      "claude.com",
      "claude.exe",
      "claude.bat",
      "claude.cmd",
    ]);
  });

  it("keeps POSIX candidates untouched off Windows", () => {
    expect(executableCandidates("claude", undefined)).toEqual(["claude"]);
  });
});
