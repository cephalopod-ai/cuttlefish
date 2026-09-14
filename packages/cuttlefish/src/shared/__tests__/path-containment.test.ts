import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathContainmentError, resolveContainedPath } from "../path-containment.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-containment-"));
  dirs.push(dir);
  return fs.realpathSync(dir);
}

describe("resolveContainedPath", () => {
  it("allows a relative path strictly inside the root", () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "sub"));
    expect(resolveContainedPath(root, "sub")).toBe(path.join(root, "sub"));
  });

  it("allows the root itself by default", () => {
    const root = makeRoot();
    expect(resolveContainedPath(root, undefined)).toBe(root);
    expect(resolveContainedPath(root, ".")).toBe(root);
  });

  it("rejects the root itself when allowRootItself is false", () => {
    const root = makeRoot();
    expect(() => resolveContainedPath(root, ".", { allowRootItself: false })).toThrow(PathContainmentError);
  });

  it("allows a nonexistent leaf path (e.g. a file a command is about to create)", () => {
    const root = makeRoot();
    expect(resolveContainedPath(root, "not-yet-created.txt")).toBe(path.join(root, "not-yet-created.txt"));
  });

  it("rejects a relative path that escapes the root via ..", () => {
    const root = makeRoot();
    expect(() => resolveContainedPath(root, "../escaped")).toThrow(PathContainmentError);
    expect(() => resolveContainedPath(root, "sub/../../escaped")).toThrow(PathContainmentError);
  });

  it("rejects escape through a symlinked intermediate directory", () => {
    const root = makeRoot();
    const outside = makeRoot();
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
    fs.symlinkSync(outside, path.join(root, "escape-link"));
    expect(() => resolveContainedPath(root, "escape-link/secret.txt")).toThrow(PathContainmentError);
  });

  it("rejects a symlinked leaf by default, and allows it when allowSymlink is set", () => {
    const root = makeRoot();
    const outside = makeRoot();
    fs.writeFileSync(path.join(outside, "target.txt"), "data");
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(root, "link.txt"));
    expect(() => resolveContainedPath(root, "link.txt")).toThrow(PathContainmentError);
    expect(resolveContainedPath(root, "link.txt", { allowSymlink: true })).toBe(path.join(root, "link.txt"));
  });

  it("throws on an empty containment root", () => {
    expect(() => resolveContainedPath("", "x")).toThrow(PathContainmentError);
  });
});
