import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point CUTTLEFISH_HOME at a temp dir BEFORE importing the module under test so
// readPathCandidates resolves the relative-path ordering against it.
const { home: tmpHome } = withStaticTempCuttlefishHome("cuttlefish-read-home-");

type Files = typeof import("../files.js");
let files: Files;

beforeAll(async () => {
  files = await import("../files.js");
});

describe("readPathCandidates — resolution order", () => {
  it("relative path: CUTTLEFISH_HOME first, then ~/Projects, then cwd, then literal", () => {
    const rel = "docs/specs/demo-project-design.md";
    const candidates = files.readPathCandidates(rel);

    // CRITICAL: CUTTLEFISH_HOME (~/.cuttlefish equivalent) must be the FIRST candidate.
    expect(candidates[0]).toBe(path.resolve(tmpHome, rel));
    // and it must come BEFORE the ~/Projects candidate.
    const projectsCandidate = path.resolve(os.homedir(), "Projects", rel);
    expect(candidates).toContain(projectsCandidate);
    expect(candidates.indexOf(candidates[0])).toBeLessThan(candidates.indexOf(projectsCandidate));

    // Full expected ordering.
    expect(candidates).toEqual([
      path.resolve(tmpHome, rel),
      path.resolve(os.homedir(), "Projects", rel),
      path.resolve(process.cwd(), rel),
      path.resolve(rel),
    ]);
  });

  it("absolute path is used verbatim (single candidate)", () => {
    const abs = "/etc/hosts";
    expect(files.readPathCandidates(abs)).toEqual([abs]);
  });

  it("home-relative path expands ~ to homedir (single candidate)", () => {
    const candidates = files.readPathCandidates("~/some/file.txt");
    expect(candidates).toEqual([path.join(os.homedir(), "some", "file.txt")]);
  });

  it("empty/whitespace path yields no candidates", () => {
    expect(files.readPathCandidates("")).toEqual([]);
    expect(files.readPathCandidates("   ")).toEqual([]);
  });
});

describe("resolveReadPath — first existing file wins", () => {
  it("prefers a relative file under CUTTLEFISH_HOME over the same path under ~/Projects logic", () => {
    const rel = "artifact-only-in-cuttlefish-home.md";
    const inHome = path.resolve(tmpHome, rel);
    fs.writeFileSync(inHome, "hello");

    const { resolvedPath, candidates } = files.resolveReadPath(rel);
    expect(resolvedPath).toBe(inHome);
    // CUTTLEFISH_HOME candidate is first.
    expect(candidates[0]).toBe(inHome);
  });

  it("returns null when no candidate exists", () => {
    const { resolvedPath } = files.resolveReadPath("definitely/missing/nope-12345.xyz");
    expect(resolvedPath).toBeNull();
  });

  it("ignores a directory candidate (not a regular file)", () => {
    const dirRel = "a-directory-not-a-file";
    fs.mkdirSync(path.resolve(tmpHome, dirRel), { recursive: true });
    const { resolvedPath } = files.resolveReadPath(dirRel);
    expect(resolvedPath).toBeNull();
  });
});

describe("isAllowedReadPath — root policy", () => {
  function ctx(gateway: Record<string, unknown>): Parameters<typeof files.isAllowedReadPath>[1] {
    return { getConfig: () => ({ gateway }) } as Parameters<typeof files.isAllowedReadPath>[1];
  }

  it("allows configured roots and denies outside paths by default", () => {
    const root = path.join(tmpHome, "allowed");
    const inside = path.join(root, "note.md");
    const outside = path.join(os.tmpdir(), "outside-note.md");
    expect(files.isAllowedReadPath(inside, ctx({ fileReadRoots: [root] }))).toBe(true);
    expect(files.isAllowedReadPath(outside, ctx({ fileReadRoots: [root] }))).toBe(false);
  });

  it("allows any path only with the explicit arbitrary-read escape hatch", () => {
    expect(files.isAllowedReadPath("/etc/hosts", ctx({ allowArbitraryFileRead: true }))).toBe(true);
  });
});

describe("classifyFile — size cap + binary detection", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-classify-"));
  });

  it("returns utf-8 content for a small text file", () => {
    const f = path.join(dir, "note.md");
    fs.writeFileSync(f, "# Hello\nworld");
    const c = files.classifyFile(f);
    expect(c.binary).toBe(false);
    expect(c.tooLarge).toBe(false);
    expect(c.mime).toBe("text/markdown");
    expect(c.content).toBe("# Hello\nworld");
    expect(c.size).toBe(Buffer.byteLength("# Hello\nworld"));
  });

  it("flags binary by MIME (png) without reading content", () => {
    const f = path.join(dir, "img.png");
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const c = files.classifyFile(f);
    expect(c.binary).toBe(true);
    expect(c.content).toBeUndefined();
    expect(c.mime).toBe("image/png");
  });

  it("flags binary by NUL byte even with a text-ish extension", () => {
    const f = path.join(dir, "weird.txt");
    fs.writeFileSync(f, Buffer.from([0x68, 0x69, 0x00, 0x21]));
    const c = files.classifyFile(f);
    expect(c.binary).toBe(true);
    expect(c.content).toBeUndefined();
  });

  it("flags tooLarge for files over MAX_READ_SIZE without reading content", () => {
    const f = path.join(dir, "big.txt");
    fs.writeFileSync(f, Buffer.alloc(files.MAX_READ_SIZE + 1, 0x41)); // 'A' * (cap+1)
    const c = files.classifyFile(f);
    expect(c.tooLarge).toBe(true);
    expect(c.binary).toBe(false);
    expect(c.content).toBeUndefined();
    expect(c.size).toBe(files.MAX_READ_SIZE + 1);
  });
});
