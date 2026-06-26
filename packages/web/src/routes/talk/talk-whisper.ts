/**
 * Cuttlefish Talk — thinking-whisper mapping (Task 13).
 *
 * While the orchestrator turn runs, its tool_use deltas are surfaced as a short,
 * muted hint under the orb ("routing…", "searching…", "preparing a card…",
 * otherwise "working…"). This is the pure mapping; the wiring lives in use-talk.
 *
 * The gateway emits two tool_use deltas per tool call:
 *   1. SSE content_block_start — carries only the tool name; `input` absent.
 *   2. PreToolUse hook — carries the same name + a truncated `input` string
 *      (first 200 chars of the stringified tool_input JSON). This second delta
 *      lets whisperFor identify curl calls to /api/talk/* endpoints and show the
 *      specific whisper instead of the generic "working…".
 */
export interface WhisperDeltaLike {
  toolName?: string
  content?: string | number
  /** Truncated (≤200 chars) stringified tool input from PreToolUse hook. */
  input?: string
}

/** Map a tool_use delta to its short under-orb whisper. */
export function whisperFor(delta: WhisperDeltaLike): string {
  const name = typeof delta.toolName === "string" ? delta.toolName : ""
  const content = typeof delta.content === "string" ? delta.content : ""
  const input = typeof delta.input === "string" ? delta.input : ""
  const hay = `${name} ${content} ${input}`.toLowerCase()
  if (hay.includes("/api/talk/delegate")) return "routing…"
  if (hay.includes("/api/talk/search")) return "searching…"
  if (hay.includes("/api/talk/card")) return "preparing a card…"
  // A bare shell/exec tool (or anything else) → generic progress.
  return "working…"
}
