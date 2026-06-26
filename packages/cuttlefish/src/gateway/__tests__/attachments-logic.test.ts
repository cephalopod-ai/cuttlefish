import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-attlogic-");

type Files = typeof import("../files.js");
type Reg = typeof import("../../sessions/registry.js");
type Paths = typeof import("../../shared/paths.js");

let files: Files;
let reg: Reg;
let paths: Paths;

beforeAll(async () => {
  paths = await import("../../shared/paths.js");
  reg = await import("../../sessions/registry.js");
  files = await import("../files.js");
  reg.initDb();
});

/** Simulate a first-message upload that landed in FILES_DIR before a session existed. */
function seedFilesDirUpload(id: string, filename: string, bytes: Buffer): void {
  const dir = path.join(paths.FILES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), bytes);
  reg.insertFile({ id, filename, size: bytes.length, mimetype: filename.endsWith(".zip") ? "application/zip" : "image/png", path: null });
}

describe("rehomeAttachmentsToSession", () => {
  it("moves FILES_DIR uploads into uploads/<date>/<sessionId>/ and records the new path", () => {
    seedFilesDirUpload("f1", "diagram.png", Buffer.from("PNG"));
    files.rehomeAttachmentsToSession(["f1"], "sess-new");

    const meta = reg.getFile("f1")!;
    expect(meta.path).toBeTruthy();
    expect(files.isServablePath(meta.path!)).toBe(true);
    expect(meta.path!.includes(path.join("uploads"))).toBe(true);
    expect(meta.path!.includes("sess-new")).toBe(true);
    expect(fs.existsSync(meta.path!)).toBe(true);
    // original FILES_DIR location is gone
    expect(fs.existsSync(path.join(paths.FILES_DIR, "f1", "diagram.png"))).toBe(false);
  });

  it("is a no-op for files already outside FILES_DIR (already session-scoped)", () => {
    // f1 was re-homed already — running again must not throw or move anything.
    const before = reg.getFile("f1")!.path;
    files.rehomeAttachmentsToSession(["f1"], "sess-new");
    expect(reg.getFile("f1")!.path).toBe(before);
  });

  it("does not escape FILES_DIR when a registered filename contains traversal", () => {
    // Mirrors POST /api/artifacts/register, which persists the raw `filename`.
    const victim = path.join(os.tmpdir(), `cuttlefish-attlogic-victim-${process.pid}.txt`);
    fs.writeFileSync(victim, "do-not-move-me");
    const rel = path.relative(path.join(paths.FILES_DIR, "evil"), victim);
    reg.insertFile({ id: "evil", filename: rel, size: 3, mimetype: "text/plain", path: null });

    files.rehomeAttachmentsToSession(["evil"], "sess-attack");

    // The traversal target must be untouched and never adopted as the file path.
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.readFileSync(victim, "utf-8")).toBe("do-not-move-me");
    expect(reg.getFile("evil")!.path).toBeNull();
    fs.rmSync(victim, { force: true });
  });
});

describe("fileIdsToMedia", () => {
  it("maps file IDs to media descriptors, deriving type from mimetype (incl. zip → file)", () => {
    seedFilesDirUpload("img", "shot.png", Buffer.from("PNG"));
    seedFilesDirUpload("zip", "bundle.zip", Buffer.from("PKzipdata"));

    const media = files.fileIdsToMedia(["img", "zip", "missing"]);
    expect(media).toHaveLength(2); // missing id skipped
    expect(media[0]).toMatchObject({ type: "image", url: "/api/files/img", name: "shot.png" });
    expect(media[1]).toMatchObject({ type: "file", url: "/api/files/zip", name: "bundle.zip", mimeType: "application/zip" });
  });

  it("returns [] for non-array input", () => {
    expect(files.fileIdsToMedia(undefined)).toEqual([]);
    expect(files.fileIdsToMedia("nope")).toEqual([]);
  });
});
