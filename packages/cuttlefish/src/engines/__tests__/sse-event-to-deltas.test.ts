import { describe, it, expect, vi } from "vitest";

// claude-interactive.ts imports node-pty at module load; mock it so this pure
// unit test stays CI-portable (no native binding needed).
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { sseEventToDeltas } from "../claude-interactive.js";

describe("sseEventToDeltas (Item D — SSE → StreamDelta mapping)", () => {
  it("maps message_start.usage to a context delta (input + cache_read + cache_creation)", () => {
    const out = sseEventToDeltas({
      type: "message_start",
      message: { usage: { input_tokens: 600, cache_read_input_tokens: 10, cache_creation_input_tokens: 6 } },
    });
    expect(out).toEqual([{ type: "context", content: "616" }]);
  });

  it("emits no context delta when usage is absent or zero", () => {
    expect(sseEventToDeltas({ type: "message_start", message: {} })).toEqual([]);
    expect(sseEventToDeltas({ type: "message_start", message: { usage: { input_tokens: 0 } } })).toEqual([]);
  });

  it("maps a content_block_start tool_use to a tool_use marker (name + id)", () => {
    const out = sseEventToDeltas({
      type: "content_block_start",
      content_block: { type: "tool_use", name: "Bash", id: "toolu_123" },
    });
    expect(out).toEqual([{ type: "tool_use", content: "Bash", toolName: "Bash", toolId: "toolu_123" }]);
  });

  it("ignores text/thinking content_block_start (their content arrives via deltas)", () => {
    expect(sseEventToDeltas({ type: "content_block_start", content_block: { type: "text" } })).toEqual([]);
    expect(sseEventToDeltas({ type: "content_block_start", content_block: { type: "thinking" } })).toEqual([]);
  });

  it("maps content_block_delta text_delta to an incremental text delta (word-by-word)", () => {
    expect(sseEventToDeltas({ type: "content_block_delta", delta: { type: "text_delta", text: "PO" } }))
      .toEqual([{ type: "text", content: "PO" }]);
    expect(sseEventToDeltas({ type: "content_block_delta", delta: { type: "text_delta", text: "NG" } }))
      .toEqual([{ type: "text", content: "NG" }]);
  });

  it("ignores empty text_delta, input_json_delta and thinking_delta", () => {
    expect(sseEventToDeltas({ type: "content_block_delta", delta: { type: "text_delta", text: "" } })).toEqual([]);
    expect(sseEventToDeltas({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } })).toEqual([]);
    expect(sseEventToDeltas({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } })).toEqual([]);
  });

  it("ignores lifecycle-only events (ping, content_block_stop, message_delta, message_stop)", () => {
    for (const type of ["ping", "content_block_stop", "message_delta", "message_stop"]) {
      expect(sseEventToDeltas({ type })).toEqual([]);
    }
  });
});
