import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Resolve paths under a throwaway home BEFORE importing the modules under test.
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-up-");

type Files = typeof import("../files.js");
type Paths = typeof import("../../shared/paths.js");
type Uploads = typeof import("../files/uploads.js");
type Registry = typeof import("../../sessions/registry.js");

let files: Files;
let paths: Paths;
let uploads: Uploads;
let registry: Registry;

beforeAll(async () => {
  paths = await import("../../shared/paths.js");
  files = await import("../files.js");
  uploads = await import("../files/uploads.js");
  registry = await import("../../sessions/registry.js");
  registry.initDb();
});

describe("sanitizeUploadFilename", () => {
  it("strips directory components (path traversal)", () => {
    expect(files.sanitizeUploadFilename("../../etc/passwd")).toBe("passwd");
    expect(files.sanitizeUploadFilename("/abs/evil.sh")).toBe("evil.sh");
    expect(files.sanitizeUploadFilename("a/b/c.png")).toBe("c.png");
  });
  it("keeps a normal filename", () => {
    expect(files.sanitizeUploadFilename("chart-01.png")).toBe("chart-01.png");
  });
  it("never returns an empty or dotted name", () => {
    expect(files.sanitizeUploadFilename("..")).not.toBe("..");
    expect(files.sanitizeUploadFilename("")).toBeTruthy();
    expect(files.sanitizeUploadFilename("/")).toBeTruthy();
  });
});

describe("sanitizeSessionId", () => {
  it("rejects traversal and separators, keeping safe chars", () => {
    expect(files.sanitizeSessionId("../../etc")).not.toContain("..");
    expect(files.sanitizeSessionId("../../etc")).not.toContain("/");
    expect(files.sanitizeSessionId("a/b")).not.toContain("/");
  });
  it("preserves a UUID-shaped id", () => {
    const id = "57d86ca0-3443-408e-b4a5-21e85e81de29";
    expect(files.sanitizeSessionId(id)).toBe(id);
  });
  it("falls back for empty/invalid ids", () => {
    expect(files.sanitizeSessionId("")).toBeTruthy();
    expect(files.sanitizeSessionId("..")).toBeTruthy();
  });
});

describe("uploadDir", () => {
  it("builds a date-bucketed, session-scoped path under UPLOADS_DIR", () => {
    const dir = files.uploadDir("sess-1", "2026-05-30");
    expect(dir).toBe(path.join(paths.UPLOADS_DIR, "2026-05-30", "sess-1"));
  });
  it("sanitizes the sessionId inside the path", () => {
    const dir = files.uploadDir("../../escape", "2026-05-30");
    expect(dir.startsWith(paths.UPLOADS_DIR)).toBe(true);
    expect(dir).not.toContain("..");
  });
});

describe("isServablePath (download scoping guard)", () => {
  it("allows files under FILES_DIR and UPLOADS_DIR", () => {
    expect(files.isServablePath(path.join(paths.FILES_DIR, "x", "a.png"))).toBe(true);
    expect(files.isServablePath(path.join(paths.UPLOADS_DIR, "2026-05-30", "s", "a.png"))).toBe(true);
  });
  it("rejects arbitrary paths outside the allowed dirs", () => {
    expect(files.isServablePath("/etc/passwd")).toBe(false);
    expect(files.isServablePath(path.join(os.homedir(), "Downloads", "secret.txt"))).toBe(false);
  });
  it("rejects traversal that escapes an allowed dir", () => {
    expect(files.isServablePath(path.join(paths.UPLOADS_DIR, "..", "..", "etc", "passwd"))).toBe(false);
  });

  it("rejects symlinks that escape managed storage", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-upload-outside-"));
    const outside = path.join(outsideDir, "secret.txt");
    const link = path.join(paths.UPLOADS_DIR, "2026-05-30", "s", "secret-link.txt");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, link);

    expect(files.isServablePath(link)).toBe(false);
  });
});

describe("saveFile persistence safety", () => {
  it("stores same-name session uploads under distinct file-id paths", async () => {
    const context = { getConfig: () => ({ gateway: {} }), emit: () => {} } as any;

    const first = await uploads.saveFile({
      id: "same-name-a",
      filename: "report.txt",
      buffer: Buffer.from("first"),
      customPath: null,
      open: false,
      sessionId: "session-uploads",
    }, context);
    const second = await uploads.saveFile({
      id: "same-name-b",
      filename: "report.txt",
      buffer: Buffer.from("second"),
      customPath: null,
      open: false,
      sessionId: "session-uploads",
    }, context);

    expect(first.path).not.toBe(second.path);
    expect(fs.readFileSync(first.path!, "utf-8")).toBe("first");
    expect(fs.readFileSync(second.path!, "utf-8")).toBe("second");
  });

  it("does not insert metadata when a custom-path write is rejected", async () => {
    const context = { getConfig: () => ({ gateway: { allowFileCustomPaths: true } }), emit: () => {} } as any;
    const customPath = path.join(paths.FILES_DIR, "custom-existing", "report.txt");
    fs.mkdirSync(path.dirname(customPath), { recursive: true });
    fs.writeFileSync(customPath, "existing");

    await expect(uploads.saveFile({
      id: "custom-rejected",
      filename: "report.txt",
      buffer: Buffer.from("new"),
      customPath,
      open: false,
    }, context)).rejects.toThrow(/already exists/);

    expect(registry.getFile("custom-rejected")).toBeUndefined();
    expect(fs.existsSync(path.join(paths.FILES_DIR, "custom-rejected", "report.txt"))).toBe(false);
    expect(fs.readFileSync(customPath, "utf-8")).toBe("existing");
  });
});
