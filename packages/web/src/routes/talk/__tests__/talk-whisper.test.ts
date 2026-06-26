/**
 * Cuttlefish Talk — thinking-whisper mapping (Task 13).
 *
 * `whisperFor` maps an orchestrator tool_use delta to a short hint shown under
 * the orb while the turn is running. Pure (no React/DOM) so the mapping contract
 * is unit-tested here. The wiring (use-talk) feeds it the live session:delta
 * tool_use payload (toolName + content + input).
 *
 * Two tool_use deltas arrive per tool call:
 *   1. content_block_start (SSE proxy) — toolName + content only, no input.
 *   2. PreToolUse hook — same toolName/content + truncated `input` JSON.
 * whisperFor is called for both; the second call (with `input`) refines the hint.
 */
import { describe, it, expect } from "vitest"
import { whisperFor } from "../talk-whisper"

describe("whisperFor", () => {
  it("maps a /api/talk/delegate call to 'routing…'", () => {
    expect(whisperFor({ content: "curl -X POST http://x/api/talk/delegate" })).toBe("routing…")
    expect(whisperFor({ toolName: "/api/talk/delegate" })).toBe("routing…")
  })

  it("maps a /api/talk/search call to 'searching…'", () => {
    expect(whisperFor({ content: "GET /api/talk/search?q=foo" })).toBe("searching…")
  })

  it("maps a /api/talk/card call to 'preparing a card…'", () => {
    expect(whisperFor({ content: "POST /api/talk/card" })).toBe("preparing a card…")
    // card sub-routes (update/dismiss/clear) still read as card prep.
    expect(whisperFor({ content: "POST /api/talk/card/update" })).toBe("preparing a card…")
  })

  it("maps a bare Bash/exec tool to 'working…'", () => {
    expect(whisperFor({ toolName: "Bash", content: "Bash" })).toBe("working…")
  })

  it("falls back to 'working…' for any unrecognized tool (default)", () => {
    expect(whisperFor({ toolName: "Read" })).toBe("working…")
    expect(whisperFor({})).toBe("working…")
    expect(whisperFor({ content: 42 })).toBe("working…")
  })

  it("matches the endpoint case-insensitively", () => {
    expect(whisperFor({ content: "/API/TALK/DELEGATE" })).toBe("routing…")
  })

  // --- input field (PreToolUse-sourced delta) ---
  describe("input field (truncated tool_input from PreToolUse hook)", () => {
    it("routes via input containing /api/talk/delegate → 'routing…'", () => {
      const input = JSON.stringify({ command: "curl -X POST http://host/api/talk/delegate -d '{}'" })
      expect(whisperFor({ toolName: "Bash", content: "Bash", input })).toBe("routing…")
    })

    it("routes via input containing /api/talk/search → 'searching…'", () => {
      const input = JSON.stringify({ command: "curl http://host/api/talk/search?q=weather" })
      expect(whisperFor({ toolName: "Bash", content: "Bash", input })).toBe("searching…")
    })

    it("routes via input containing /api/talk/card → 'preparing a card…'", () => {
      const input = JSON.stringify({ command: "curl -X POST http://host/api/talk/card" })
      expect(whisperFor({ toolName: "Bash", content: "Bash", input })).toBe("preparing a card…")
    })

    it("card sub-routes via input still map to 'preparing a card…'", () => {
      const input = JSON.stringify({ command: "curl -X POST http://host/api/talk/card/update" })
      expect(whisperFor({ toolName: "Bash", content: "Bash", input })).toBe("preparing a card…")
    })

    it("first delta (no input) shows 'working…'; second delta (with input) refines to specific whisper", () => {
      // First delta: content_block_start, no input
      expect(whisperFor({ toolName: "Bash", content: "Bash" })).toBe("working…")
      // Second delta: PreToolUse, input assembled
      const input = JSON.stringify({ command: "curl http://host/api/talk/delegate" })
      expect(whisperFor({ toolName: "Bash", content: "Bash", input })).toBe("routing…")
    })

    it("empty input string falls back to content/name matching", () => {
      expect(whisperFor({ toolName: "Bash", content: "Bash", input: "" })).toBe("working…")
    })

    it("input with no talk endpoint still yields 'working…'", () => {
      const input = JSON.stringify({ command: "ls -la /tmp" })
      expect(whisperFor({ toolName: "Bash", content: "Bash", input })).toBe("working…")
    })

    it("matches endpoint in input case-insensitively", () => {
      const input = JSON.stringify({ url: "/API/TALK/DELEGATE" })
      expect(whisperFor({ toolName: "Bash", content: "Bash", input })).toBe("routing…")
    })
  })
})
