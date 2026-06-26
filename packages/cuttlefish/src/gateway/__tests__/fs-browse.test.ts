import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { listDirectory, FsBrowseError } from "../fs-browse.js";

let root: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fsb-")));
  fs.mkdirSync(path.join(root, "alpha"));
  fs.mkdirSync(path.join(root, "beta"));
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.writeFileSync(path.join(root, "a-file.txt"), "x");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("listDirectory", () => {
  it("lists subdirectories only, sorted, excluding files and dotdirs", () => {
    const r = listDirectory(root, { defaultDir: root });
    expect(r.path).toBe(root);
    expect(r.entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
    expect(r.entries.every((e) => e.isDir)).toBe(true);
  });

  it("falls back to defaultDir when no path is given", () => {
    const r = listDirectory(undefined, { defaultDir: root });
    expect(r.path).toBe(root);
  });

  it("throws on a non-existent path", () => {
    expect(() => listDirectory(path.join(root, "nope"), { defaultDir: root })).toThrow(FsBrowseError);
  });

  it("throws on a file (not a directory)", () => {
    expect(() => listDirectory(path.join(root, "a-file.txt"), { defaultDir: root })).toThrow(/not a directory/);
  });

  it("exposes a parent when free-browsing", () => {
    const r = listDirectory(path.join(root, "alpha"), { defaultDir: root });
    expect(r.parent).toBe(root);
  });

  it("with roots set, rejects a path outside and nulls the parent at the root boundary", () => {
    const sub = path.join(root, "alpha");
    const inside = listDirectory(sub, { roots: [root], defaultDir: root });
    expect(inside.parent).toBe(root); // parent still inside the root
    const atRoot = listDirectory(root, { roots: [root], defaultDir: root });
    expect(atRoot.parent).toBeNull(); // cannot escape above the allow-root
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fsb-out-")));
    try {
      const err = (() => { try { listDirectory(outside, { roots: [root], defaultDir: root }); } catch (e) { return e; } })();
      expect(err).toBeInstanceOf(FsBrowseError);
      expect((err as FsBrowseError).status).toBe(403);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("blocks .. traversal escape via realpath (resolves to outside root → 403)", () => {
    expect(() => listDirectory(path.join(root, ".."), { roots: [root], defaultDir: root })).toThrow(FsBrowseError);
  });
});
