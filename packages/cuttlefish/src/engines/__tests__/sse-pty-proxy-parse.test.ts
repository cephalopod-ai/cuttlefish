import { describe, it, expect } from "vitest";
import { SsePtyProxy, type SseDataEvent } from "../sse-pty-proxy.js";

// Locks the SSE framing parser. parseSse(buf) consumes COMPLETE frames (separated by
// a blank line — \n\n or \r\n\r\n), JSON.parses each frame's concatenated `data:`
// payload, fires onEvent per frame, and RETURNS the trailing incomplete remainder so
// the next chunk can be re-fed prefixed with it. parseSse is private; we reach it the
// same way sse-pty-proxy-main-only.test.ts reaches shouldTeeToUi.

/** Build a proxy whose onEvent captures every parsed event. */
function makeProxy() {
  const events: SseDataEvent[] = [];
  const proxy = new SsePtyProxy("test", (e) => events.push(e));
  const parse = (buf: string) =>
    (proxy as unknown as { parseSse(b: string): string }).parseSse(buf);
  return { events, parse };
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe("SsePtyProxy.parseSse", () => {
  it("parses a single complete frame, fires onEvent once, returns empty remainder", () => {
    const { events, parse } = makeProxy();
    const rest = parse(frame({ type: "message_start", id: "m1" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "message_start", id: "m1" });
    expect(rest).toBe("");
  });

  it("parses two frames in one buffer, in order", () => {
    const { events, parse } = makeProxy();
    const rest = parse(frame({ type: "a", n: 1 }) + frame({ type: "b", n: 2 }));
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "a", n: 1 });
    expect(events[1]).toEqual({ type: "b", n: 2 });
    expect(rest).toBe("");
  });

  it("handles a frame split across two parseSse calls without data loss", () => {
    const { events, parse } = makeProxy();
    const full = frame({ type: "content_block_delta", text: "hello world" });
    const half = Math.floor(full.length / 2);
    const part1 = full.slice(0, half);
    const part2 = full.slice(half);

    // First half: no complete frame yet → no event, remainder returned verbatim.
    const remainder = parse(part1);
    expect(events).toHaveLength(0);
    expect(remainder).toBe(part1);

    // Feed the rest prefixed with the remainder → event now fires.
    const rest = parse(remainder + part2);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "content_block_delta", text: "hello world" });
    expect(rest).toBe("");
  });

  it("handles \\r\\n\\r\\n frame delimiter the same as \\n\\n", () => {
    const { events, parse } = makeProxy();
    const rest = parse(`data: ${JSON.stringify({ type: "crlf", ok: true })}\r\n\r\n`);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "crlf", ok: true });
    expect(rest).toBe("");
  });

  it("ignores [DONE] sentinel and empty data, never firing onEvent", () => {
    const { events, parse } = makeProxy();
    const rest = parse("data: [DONE]\n\n" + "data: \n\n" + "data:\n\n");
    expect(events).toHaveLength(0);
    expect(rest).toBe("");
  });

  it("skips a malformed JSON data line without throwing, still parsing a following good frame", () => {
    const { events, parse } = makeProxy();
    const rest = parse("data: {not valid json}\n\n" + frame({ type: "good", v: 42 }));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "good", v: 42 });
    expect(rest).toBe("");
  });

  it("concatenates multiple data: lines within one frame before JSON.parse", () => {
    const { events, parse } = makeProxy();
    // Split a single JSON object across two data: lines in the SAME frame.
    const json = JSON.stringify({ type: "multiline", payload: "abc" });
    const a = json.slice(0, 10);
    const b = json.slice(10);
    const rest = parse(`data: ${a}\ndata: ${b}\n\n`);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "multiline", payload: "abc" });
    expect(rest).toBe("");
  });
});
