import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { validateCwd } from "../session-patch.js";

let dir: string;
let file: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcwd-"));
  file = path.join(dir, "a-file.txt");
  fs.writeFileSync(file, "x");
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("validateCwd", () => {
  it("accepts an existing directory and returns the realpath", () => {
    const r = validateCwd(dir);
    expect(r.ok).toBe(true);
    expect(r.cwd).toBe(fs.realpathSync(dir));
  });

  it("rejects a non-existent path", () => {
    const r = validateCwd(path.join(dir, "does-not-exist"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not exist/);
  });

  it("rejects a path that is a file, not a directory", () => {
    const r = validateCwd(file);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a directory/);
  });

  it("rejects empty / non-string input", () => {
    expect(validateCwd("").ok).toBe(false);
    expect(validateCwd(undefined).ok).toBe(false);
    expect(validateCwd(123 as unknown).ok).toBe(false);
  });

  it("accepts a dir inside an allowed root", () => {
    const sub = fs.mkdtempSync(path.join(dir, "sub-"));
    const r = validateCwd(sub, { roots: [dir] });
    expect(r.ok).toBe(true);
  });

  it("rejects a dir outside the allowed roots", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vcwd-out-"));
    const r = validateCwd(outside, { roots: [dir] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/outside allowed/);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("blocks .. traversal escape via realpath resolution", () => {
    const escape = path.join(dir, "..");
    const r = validateCwd(escape, { roots: [dir] });
    expect(r.ok).toBe(false);
  });
});
