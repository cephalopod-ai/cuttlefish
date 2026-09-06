import { describe, it, expect } from "vitest";
import { CompactionStreamGate } from "../claude-compaction-gate.js";
import { isCompactionSummaryText } from "../claude-interactive-transcript.js";
import type { StreamDelta } from "../../shared/types.js";
import type { SseDataEvent } from "../sse-pty-proxy.js";

const START: SseDataEvent = { type: "message_start" };
const STOP: SseDataEvent = { type: "message_stop" };
const DELTA: SseDataEvent = { type: "content_block_delta" };

function text(content: string): StreamDelta {
  return { type: "text", content };
}

/** Feed `chunks` as one text delta each and collect everything the gate passes. */
function streamText(gate: CompactionStreamGate, chunks: string[], opts: { stop?: boolean } = {}): string {
  const out: StreamDelta[] = [];
  out.push(...gate.filter(START, []));
  for (const chunk of chunks) out.push(...gate.filter(DELTA, [text(chunk)]));
  if (opts.stop !== false) out.push(...gate.filter(STOP, []));
  return out.filter((d) => d.type === "text").map((d) => d.content).join("");
}

describe("CompactionStreamGate — auto-compaction never reaches the chat (UPS-A6)", () => {
  it("drops a message that opens with <analysis>, however it is chunked", () => {
    // One chunk, and split across the marker, which is how the SSE stream
    // actually arrives.
    expect(streamText(new CompactionStreamGate(), ["<analysis>the session so far</analysis><summary>x</summary>"])).toBe("");
    expect(streamText(new CompactionStreamGate(), ["<ana", "lysis", ">continued", " summary text"])).toBe("");
    expect(streamText(new CompactionStreamGate(), ["<", "a", "n", "a", "l", "y", "s", "i", "s", ">", "tail"])).toBe("");
  });

  it("drops the rest of a compaction message, not just its opening", () => {
    const gate = new CompactionStreamGate();
    const passed = streamText(gate, ["<analysis>", "a".repeat(5000), "</analysis>", "<summary>more</summary>"]);
    expect(passed).toBe("");
    expect(gate.isDroppingMessage).toBe(true);
  });

  it("passes ordinary output through unchanged and in order", () => {
    expect(streamText(new CompactionStreamGate(), ["Sure", ", here", " is the answer."])).toBe("Sure, here is the answer.");
    expect(streamText(new CompactionStreamGate(), ["I"])).toBe("I");
    expect(streamText(new CompactionStreamGate(), ["<a", "side from that, no."])).toBe("<aside from that, no.");
  });

  it("tolerates leading whitespace before the marker on both verdicts", () => {
    expect(streamText(new CompactionStreamGate(), ["\n\n  <analysis>hidden"])).toBe("");
    expect(streamText(new CompactionStreamGate(), ["\n\n  Visible answer"])).toBe("\n\n  Visible answer");
  });

  it("releases held text rather than swallowing it when the message ends short", () => {
    expect(streamText(new CompactionStreamGate(), ["<an"])).toBe("<an");
  });

  it("releases held text on flush when the stream dies mid-message", () => {
    const gate = new CompactionStreamGate();
    gate.filter(START, []);
    gate.filter(DELTA, [text("<ana")]);
    const flushed = gate.flush().map((d) => d.content).join("");
    expect(flushed).toBe("<ana");
    // Flushing twice must not duplicate the text.
    expect(gate.flush()).toEqual([]);
  });

  it("stops holding after a long whitespace run instead of buffering forever", () => {
    const lead = " ".repeat(200);
    expect(streamText(new CompactionStreamGate(), [lead, "then words"])).toBe(`${lead}then words`);
  });

  it("lets structural deltas past even inside a dropped message", () => {
    const gate = new CompactionStreamGate();
    gate.filter(START, []);
    gate.filter(DELTA, [text("<analysis>x")]);
    const structural = gate.filter({ type: "message_start" } as SseDataEvent, [{ type: "context", content: "1234" }]);
    expect(structural).toEqual([{ type: "context", content: "1234" }]);
  });

  it("starts a fresh verdict for the next message", () => {
    const gate = new CompactionStreamGate();
    expect(streamText(gate, ["<analysis>dropped"])).toBe("");
    expect(streamText(gate, ["a real answer"])).toBe("a real answer");
  });
});

describe("isCompactionSummaryText — the transcript recovery path uses the same marker", () => {
  it("recognises a compaction summary and leaves ordinary text alone", () => {
    expect(isCompactionSummaryText("<analysis>...")).toBe(true);
    expect(isCompactionSummaryText("\n  <analysis>...")).toBe(true);
    expect(isCompactionSummaryText("Here is the result.")).toBe(false);
    expect(isCompactionSummaryText("<aside>not this</aside>")).toBe(false);
  });
});
