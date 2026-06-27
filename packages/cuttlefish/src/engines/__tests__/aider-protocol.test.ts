import { describe, it, expect } from "vitest";
import { aiderHistoryPathFor, parseAiderHistoryLine } from "../aider-protocol.js";

describe("aiderHistoryPathFor", () => {
  it("derives a per-session path under the aider-history dir", () => {
    const p = aiderHistoryPathFor("sess-123");
    expect(p.endsWith("/aider-history/sess-123.md")).toBe(true);
  });

  it("sanitizes unsafe characters in the session id", () => {
    const p = aiderHistoryPathFor("../weird/id*name");
    expect(p.endsWith("/aider-history/.._weird_id_name.md")).toBe(true);
  });
});

describe("parseAiderHistoryLine", () => {
  it("ignores blank lines and section headers", () => {
    expect(parseAiderHistoryLine("")).toEqual({ deltas: [] });
    expect(parseAiderHistoryLine("# aider chat started at 2026-06-27")).toEqual({ deltas: [] });
  });

  it("flags user-prompt echo lines as a turn start with no output", () => {
    const parsed = parseAiderHistoryLine("#### implement the feature");
    expect(parsed.userTurn).toBe(true);
    expect(parsed.deltas).toEqual([]);
    expect(parsed.assistantText).toBeUndefined();
  });

  it("treats prose as assistant text", () => {
    const parsed = parseAiderHistoryLine("Here is the change you asked for.");
    expect(parsed.assistantText).toBe("Here is the change you asked for.\n");
    expect(parsed.deltas).toEqual([{ type: "text", content: "Here is the change you asked for.\n" }]);
  });

  it("surfaces aider blockquotes as status deltas", () => {
    const parsed = parseAiderHistoryLine("> Applied edit to foo.py");
    expect(parsed.tokensLine).toBeUndefined();
    expect(parsed.deltas).toEqual([{ type: "status", content: "Applied edit to foo.py" }]);
  });

  it("flags the usage blockquote as an end-of-turn signal", () => {
    const parsed = parseAiderHistoryLine("> Tokens: 1.2k sent, 345 received. Cost: $0.01");
    expect(parsed.tokensLine).toBe(true);
    expect(parsed.deltas[0]?.type).toBe("status");
  });
});
