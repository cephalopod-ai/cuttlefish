import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeDestructivePath, safeRmSync } from "../safe-delete.js";

describe("assertSafeDestructivePath", () => {
  it("rejects catastrophic deletion targets", () => {
    expect(() => assertSafeDestructivePath(path.parse(os.homedir()).root)).toThrow(/filesystem root/);
    expect(() => assertSafeDestructivePath(os.homedir())).toThrow(/user home directory/);
    expect(() => assertSafeDestructivePath(process.cwd())).toThrow(/current working directory/);
  });

  it("rejects an empty or whitespace target", () => {
    expect(() => assertSafeDestructivePath("")).toThrow(/empty/);
    expect(() => assertSafeDestructivePath("   ")).toThrow(/empty/);
  });

  it("rejects a symlinked target before deletion", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-safe-delete-"));
    try {
      const target = path.join(root, "target");
      const link = path.join(root, "link");
      fs.mkdirSync(target);
      fs.symlinkSync(target, link);
      expect(() => assertSafeDestructivePath(link)).toThrow(/symlink/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the resolved path for a safe absolute target", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-safe-delete-"));
    try {
      const child = path.join(root, "child");
      expect(assertSafeDestructivePath(child)).toBe(path.resolve(child));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  describe("with a containment root (within)", () => {
    it("accepts a path lexically contained in the base (tmp may itself be a symlink)", () => {
      const base = os.tmpdir();
      const child = path.join(base, "cuttlefish-safe-delete-child");
      expect(assertSafeDestructivePath(child, { within: base })).toBe(path.resolve(child));
    });

    it("rejects a path that escapes the base via ..", () => {
      const base = path.join(os.tmpdir(), "cuttlefish-safe-delete-base");
      const escape = path.join(base, "..", "..", "etc");
      expect(() => assertSafeDestructivePath(escape, { within: base })).toThrow(/outside its managed root/);
    });

    it("rejects the base directory itself", () => {
      const base = path.join(os.tmpdir(), "cuttlefish-safe-delete-base");
      expect(() => assertSafeDestructivePath(base, { within: base })).toThrow(/containment root/);
    });

    it("rejects a sibling that shares a name prefix with the base", () => {
      const base = path.join(os.tmpdir(), "bundle");
      const sibling = path.join(os.tmpdir(), "bundle-evil");
      expect(() => assertSafeDestructivePath(sibling, { within: base })).toThrow(/outside its managed root/);
    });

    it("rejects a target whose intermediate directory symlinks outside the base", () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-safe-delete-base-"));
      const evil = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-safe-delete-evil-"));
      try {
        fs.writeFileSync(path.join(evil, "secret.txt"), "x");
        // base/mid -> evil, so base/mid/secret.txt is lexically "inside" base but
        // really lives in evil. Lexical containment alone would wrongly accept it.
        fs.symlinkSync(evil, path.join(base, "mid"));
        expect(() =>
          assertSafeDestructivePath(path.join(base, "mid", "secret.txt"), { within: base }),
        ).toThrow(/outside its managed root/);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(evil, { recursive: true, force: true });
      }
    });
  });
});

describe("safeRmSync", () => {
  let root = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-safe-rm-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns false when the target is already absent", () => {
    const missing = path.join(root, "nope");
    expect(safeRmSync(missing, { within: root })).toBe(false);
  });

  it("recursively removes a contained directory tree", () => {
    const dir = path.join(root, "tree");
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nested", "f.txt"), "x");
    expect(safeRmSync(dir, { within: root })).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("removes a single file when recursive is false", () => {
    const file = path.join(root, "one.txt");
    fs.writeFileSync(file, "x");
    expect(safeRmSync(file, { within: root, recursive: false })).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses to delete outside the containment root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-safe-rm-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "keep.txt"), "x");
      expect(() => safeRmSync(path.join(outside, "keep.txt"), { within: root })).toThrow(/outside its managed root/);
      expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
