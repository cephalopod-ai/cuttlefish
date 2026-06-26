import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Tests for forkCodexSession() in ../fork.ts.
 *
 * forkCodexSession reads/writes ~/.codex/sessions, deriving the root from
 * os.homedir(). We mock node:os so homedir() points at a throwaway temp dir,
 * keeping the real filesystem untouched. The dest layout mirrors the source:
 *   <home>/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
 * (year/month/day are UTC-derived in fork.ts).
 */

let fakeHome: string;

// fork.ts now transitively imports shared/paths.js (via safe-write), whose
// INSTANCES_REGISTRY/resolveHome call os.homedir() at MODULE-EVAL — before
// beforeEach runs. Referencing the `let fakeHome` from the (hoisted) mock
// factory hits its TDZ. Back the mock with a vi.hoisted holder instead (safe to
// read at any time); beforeEach points it at the real temp home.
const homeHolder = vi.hoisted(() => ({ dir: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => homeHolder.dir,
    },
    homedir: () => homeHolder.dir,
  };
});

// Silence the logger so test output stays clean.
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { forkCodexSession } from "../fork.js";

const SESSIONS_REL = [".codex", "sessions"];

function sessionsRoot(): string {
  return path.join(fakeHome, ...SESSIONS_REL);
}

/**
 * Seed a source codex JSONL under a fixed date dir and return its full path.
 * `firstLine` and `rest` are written verbatim (so we can inject corrupt data).
 */
function seedSource(
  sessionId: string,
  firstLine: string,
  rest: string[],
  date: { y: string; m: string; d: string } = { y: "2025", m: "01", d: "02" },
): string {
  const dir = path.join(sessionsRoot(), date.y, date.m, date.d);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2025-01-02T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(file, [firstLine, ...rest].join("\n"));
  return file;
}

/** Find the single forked file (dated dir != the source's 2025/01/02). */
function findForkedFile(excludeSourceFile: string): string | null {
  const root = sessionsRoot();
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".jsonl") && full !== excludeSourceFile) found.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found[0] ?? null;
}

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fork-codex-"));
  homeHolder.dir = fakeHome; // point the mocked os.homedir() at the temp home
});

afterEach(() => {
  if (fakeHome && fs.existsSync(fakeHome)) fs.rmSync(fakeHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("forkCodexSession", () => {
  it("happy path: forks with a new uuid, copies later lines verbatim, rewrites first-line id + timestamp", () => {
    const srcId = "11111111-1111-1111-1111-111111111111";
    const meta = {
      type: "session_meta",
      timestamp: "2025-01-02T00:00:00.000Z",
      payload: { id: srcId, cwd: "/tmp/project" },
    };
    const line2 = JSON.stringify({ type: "message", role: "user", content: "hello" });
    const line3 = JSON.stringify({ type: "message", role: "assistant", content: "hi there" });
    const sourceFile = seedSource(srcId, JSON.stringify(meta), [line2, line3]);

    const before = new Date().toISOString();
    const result = forkCodexSession(srcId);
    const after = new Date().toISOString();

    // Returns a new uuid distinct from the input.
    expect(result.engineSessionId).toBeTruthy();
    expect(result.engineSessionId).not.toBe(srcId);
    expect(result.engineSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // A new file exists in a dated dir, named rollout-<ts>-<newUuid>.jsonl.
    const forked = findForkedFile(sourceFile);
    expect(forked).not.toBeNull();
    expect(path.basename(forked!)).toContain(result.engineSessionId);
    expect(path.basename(forked!)).toMatch(/^rollout-.*\.jsonl$/);

    const forkedLines = fs.readFileSync(forked!, "utf-8").split("\n");

    // First line: NEW id + a fresh timestamp (within the call window).
    const newMeta = JSON.parse(forkedLines[0]);
    expect(newMeta.payload.id).toBe(result.engineSessionId);
    expect(newMeta.payload.id).not.toBe(srcId);
    expect(newMeta.payload.cwd).toBe("/tmp/project"); // untouched fields preserved
    expect(typeof newMeta.timestamp).toBe("string");
    expect(newMeta.timestamp >= before && newMeta.timestamp <= after).toBe(true);
    expect(newMeta.timestamp).not.toBe(meta.timestamp);

    // Remaining lines copied verbatim.
    expect(forkedLines[1]).toBe(line2);
    expect(forkedLines[2]).toBe(line3);
  });

  it("throws 'Codex session file not found' when the source does not exist", () => {
    // Ensure the sessions root exists but contains no matching file.
    fs.mkdirSync(sessionsRoot(), { recursive: true });
    expect(() => forkCodexSession("does-not-exist-id")).toThrow(/Codex session file not found/);
  });

  it("corrupt first line: throws a contextual error naming the session id, the source file, and 'not valid JSON'", () => {
    const srcId = "22222222-2222-2222-2222-222222222222";
    const sourceFile = seedSource(srcId, "{not valid json,,,", [
      JSON.stringify({ type: "message", content: "x" }),
    ]);

    let caught: Error | undefined;
    try {
      forkCodexSession(srcId);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    // Hardened contextual error — NOT a bare SyntaxError.
    expect(caught!.message).toContain(srcId);
    expect(caught!.message).toContain(sourceFile);
    expect(caught!.message).toContain("not valid JSON");
  });

  it("first line valid JSON but no payload.id: copies through unchanged without throwing", () => {
    const srcId = "33333333-3333-3333-3333-333333333333";
    // Valid JSON, but no payload.id — fork.ts leaves the line as-is.
    const firstLine = JSON.stringify({ type: "session_meta", timestamp: "2025-01-02T00:00:00.000Z", payload: { cwd: "/x" } });
    const line2 = JSON.stringify({ type: "message", content: "preserved" });
    const sourceFile = seedSource(srcId, firstLine, [line2]);

    let result!: ReturnType<typeof forkCodexSession>;
    expect(() => {
      result = forkCodexSession(srcId);
    }).not.toThrow();

    const forked = findForkedFile(sourceFile);
    expect(forked).not.toBeNull();
    const forkedLines = fs.readFileSync(forked!, "utf-8").split("\n");

    // First line copied verbatim (no id to rewrite → left untouched).
    expect(forkedLines[0]).toBe(firstLine);
    expect(forkedLines[1]).toBe(line2);
    // Still returns a fresh uuid (the file id is just not rewritten).
    expect(result.engineSessionId).not.toBe(srcId);
  });
});
