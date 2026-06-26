import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveBin } from "../resolve-bin.js";

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
});
