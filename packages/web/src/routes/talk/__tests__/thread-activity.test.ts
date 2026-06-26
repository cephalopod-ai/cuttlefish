import { describe, expect, it } from "vitest"
import { activityFor, excerpt, threadActivityReducer } from "../thread-activity"

describe("excerpt", () => {
  it("strips markdown, urls and uuids, flattens whitespace", () => {
    const raw = "**Done!** See https://x.test/r `code` 0b6a7c1e-1111-2222-3333-444455556666\n\nNext   steps"
    expect(excerpt(raw, 140)).toBe("Done! See code Next steps")
  })
  it("caps at max chars with an ellipsis", () => {
    expect(excerpt("word ".repeat(60), 40).length).toBeLessThanOrEqual(40)
    expect(excerpt("word ".repeat(60), 40).endsWith("…")).toBe(true)
  })
  it("returns empty string for empty/noise-only input", () => {
    expect(excerpt("``` ```", 140)).toBe("")
  })
  it("produces well-formed output when truncation falls on a surrogate pair", () => {
    // Each 👍 is U+1F44D — a two-code-unit astral char. Truncating naively in the
    // middle of one leaves a lone high surrogate before the "…".
    const out = excerpt("okk " + "👍".repeat(100), 40)
    expect(out.endsWith("…")).toBe(true)
    // The slice before "…" must not end with a lone high surrogate (D800–DBFF).
    expect(/[\uD800-\uDBFF]$/.test(out.slice(0, -1))).toBe(false)
  })
})

describe("activityFor", () => {
  it("maps delegation spawns", () => {
    expect(activityFor({ toolName: "Bash", input: 'curl -X POST /api/sessions {"parentSessionId":"x"}' })).toBe("delegating…")
  })
  it("maps file reads and edits", () => {
    expect(activityFor({ toolName: "Read" })).toBe("reading…")
    expect(activityFor({ toolName: "Edit" })).toBe("editing…")
  })
  it("maps web work and shell, defaults to working", () => {
    expect(activityFor({ toolName: "WebSearch" })).toBe("searching the web…")
    expect(activityFor({ toolName: "Bash", input: "ls -la" })).toBe("running commands…")
    expect(activityFor({ toolName: "SomethingNew" })).toBe("working…")
  })
  it("maps codex-interactive tool aliases", () => {
    expect(activityFor({ toolName: "file_edit" })).toBe("editing…")
    expect(activityFor({ toolName: "file_read" })).toBe("reading…")
    expect(activityFor({ toolName: "shell" })).toBe("running commands…")
    expect(activityFor({ toolName: "command_execution" })).toBe("running commands…")
  })
  it("does not treat an Edit with gateway tokens in its input as delegation", () => {
    // Fix: spawn heuristic is scoped to shell-ish tools so gateway source code
    // in old_string/new_string doesn't misclassify an Edit as "delegating…".
    expect(
      activityFor({ toolName: "Edit", input: 'old_string: "/api/sessions parentSessionId"' }),
    ).toBe("editing…")
  })
})

describe("threadActivityReducer", () => {
  it("sets activity, then report clears the live line", () => {
    let m = threadActivityReducer(new Map(), { type: "activity", id: "a", text: "reading…" })
    expect(m.get("a")).toEqual({ activity: "reading…" })
    m = threadActivityReducer(m, { type: "report", id: "a", text: "All done." })
    expect(m.get("a")).toEqual({ reportExcerpt: "All done." })
  })
  it("is referentially stable on no-op updates", () => {
    const m1 = threadActivityReducer(new Map(), { type: "activity", id: "a", text: "x" })
    const m2 = threadActivityReducer(m1, { type: "activity", id: "a", text: "x" })
    expect(m2).toBe(m1)
  })
  it("drops empty report excerpts but still clears activity", () => {
    let m = threadActivityReducer(new Map(), { type: "activity", id: "a", text: "x" })
    m = threadActivityReducer(m, { type: "report", id: "a", text: "" })
    expect(m.get("a")).toEqual({})
  })
  it("surfaces error text in reportExcerpt (mirrors use-talk ev.error fallback)", () => {
    // use-talk dispatches: text: ev.result ?? ev.error ?? ""
    // This test verifies the reducer correctly stores an error message as the excerpt.
    const m = threadActivityReducer(new Map(), { type: "report", id: "e", text: "Boom: stack overflow" })
    expect(m.get("e")?.reportExcerpt).toBe("Boom: stack overflow")
  })
})
