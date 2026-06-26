import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// node-pty loads a native module at import time (fails on CI); the recovery
// helpers are pure-JS, so mock it to keep this test focused + portable.
import { vi } from "vitest";
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { findTranscriptForSession, lastAssistantTextFromTranscript } from "../claude-interactive.js";

/** Write a minimal Claude transcript (JSONL) with the given assistant texts in order. */
function writeTranscript(dir: string, sessionId: string, assistantTexts: string[]): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }));
  for (const text of assistantTexts) {
    lines.push(JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } },
    }));
  }
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("transcript recovery (lost Stop hook → backfill from disk)", () => {
  it("extracts the LAST assistant text block from a transcript", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-tr-"));
    const file = writeTranscript(tmp, "sess-1", ["first turn", "middle turn", "FINAL turn"]);
    expect(lastAssistantTextFromTranscript(file)).toBe("FINAL turn");
  });

  it("can filter recovered assistant text to the current turn by timestamp", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-tr-"));
    const file = path.join(tmp, "timed.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-16T10:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "previous" }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-16T10:00:10.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "current" }] },
      }),
    ].join("\n") + "\n");

    expect(lastAssistantTextFromTranscript(file, Date.parse("2026-06-16T10:00:05.000Z"))).toBe("current");
    expect(lastAssistantTextFromTranscript(file, Date.parse("2026-06-16T10:00:11.000Z"))).toBeUndefined();
  });

  it("does not timestamp-filter untimed assistant rows", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-tr-"));
    const file = writeTranscript(tmp, "untimed", ["previous"]);
    expect(lastAssistantTextFromTranscript(file, Date.now())).toBeUndefined();
  });

  it("returns undefined for a transcript with no assistant text", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-tr-"));
    const file = path.join(tmp, "empty.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
    expect(lastAssistantTextFromTranscript(file)).toBeUndefined();
  });

  it("returns undefined for a missing file (no throw)", () => {
    expect(lastAssistantTextFromTranscript("/nonexistent/path.jsonl")).toBeUndefined();
  });

  it("locates a transcript by session id via the cwd-slug heuristic", () => {
    const projects = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-proj-"));
    const home = "/Users/test/.cuttlefish";
    const slugDir = path.join(projects, home.replace(/[/.]/g, "-"));
    fs.mkdirSync(slugDir, { recursive: true });
    const file = writeTranscript(slugDir, "abc-123", ["only turn"]);
    expect(findTranscriptForSession("abc-123", home, projects)).toBe(file);
  });

  it("falls back to scanning project dirs when the slug misses", () => {
    const projects = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-proj-"));
    const otherDir = path.join(projects, "-some-other-project");
    fs.mkdirSync(otherDir, { recursive: true });
    const file = writeTranscript(otherDir, "xyz-789", ["recovered"]);
    // home slug points elsewhere; scan should still find it
    expect(findTranscriptForSession("xyz-789", "/Users/test/.cuttlefish", projects)).toBe(file);
  });

  it("returns undefined for empty/unknown session id", () => {
    const projects = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-proj-"));
    expect(findTranscriptForSession("", "/Users/test/.cuttlefish", projects)).toBeUndefined();
    expect(findTranscriptForSession("never-existed", "/Users/test/.cuttlefish", projects)).toBeUndefined();
  });
});
