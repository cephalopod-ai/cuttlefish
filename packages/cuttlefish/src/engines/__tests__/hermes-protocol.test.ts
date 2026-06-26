// packages/cuttlefish/src/engines/__tests__/hermes-protocol.test.ts
import { describe, it, expect } from "vitest";
import {
  encodeModelChoice, splitModelChoice, rpcRequest, mapSessionUpdate,
} from "../hermes-protocol.js";

describe("model choice encoding", () => {
  it("encodes provider:model and splits back", () => {
    expect(encodeModelChoice("openai-codex", "gpt-5.5")).toBe("openai-codex:gpt-5.5");
    expect(splitModelChoice("openai-codex:gpt-5.5")).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
    expect(splitModelChoice("gpt-5.5")).toEqual({ provider: undefined, model: "gpt-5.5" });
  });
});

describe("rpcRequest", () => {
  it("produces a newline-terminated JSON-RPC 2.0 line", () => {
    const line = rpcRequest(1, "initialize", { protocolVersion: 1 });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  });
});

describe("mapSessionUpdate", () => {
  it("maps an answer chunk to a text delta", () => {
    const r = mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
    expect(r.deltas).toEqual([{ type: "text", content: "hi" }]);
  });
  it("drops reasoning chunks from text (no leak)", () => {
    const r = mapSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret reasoning" } });
    expect(r.deltas.filter((d) => d.type === "text")).toEqual([]);
  });
  it("maps usage_update to contextTokens", () => {
    const r = mapSessionUpdate({ sessionUpdate: "usage_update", size: 272000, used: 11833 });
    expect(r.contextTokens).toBe(11833);
    expect(r.deltas).toContainEqual({ type: "context", content: "11833" });
  });
  it("maps a tool_call to a tool_use delta", () => {
    const r = mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", rawInput: { cmd: "ls" } });
    expect(r.deltas[0]).toMatchObject({ type: "tool_use", toolId: "t1", toolName: "bash" });
  });
  it("maps plan updates to a reusable task-list block", () => {
    const r = mapSessionUpdate({
      sessionUpdate: "plan",
      entries: [
        { content: "Read current chat stream", status: "completed", priority: "high" },
        { content: "Render structured blocks", status: "in_progress", priority: "high" },
      ],
    });

    expect(r.deltas[0]).toMatchObject({
      type: "block",
      block: {
        op: "put",
        block: {
          id: "hermes-plan",
          type: "task-list",
          version: 1,
          sourceEngine: "hermes",
          payload: {
            items: [
              { id: "plan-0", text: "Read current chat stream", status: "done", priority: "high" },
              { id: "plan-1", text: "Render structured blocks", status: "running", priority: "high" },
            ],
          },
        },
      },
    });
  });
  it("marks the aggregate plan block as error when any entry failed", () => {
    const r = mapSessionUpdate({
      sessionUpdate: "plan",
      entries: [
        { content: "Read current chat stream", status: "completed" },
        { content: "Render structured blocks", status: "failed" },
      ],
    });

    expect(r.deltas[0]).toMatchObject({
      type: "block",
      block: {
        block: {
          status: "error",
          payload: {
            items: [
              { text: "Read current chat stream", status: "done" },
              { text: "Render structured blocks", status: "error" },
            ],
          },
        },
      },
    });
  });
  it("keeps tool calls but ignores ACP diff content in chat mode", () => {
    const r = mapSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "edit",
      rawInput: { path: "src/app.ts" },
      content: [
        {
          type: "diff",
          path: "src/app.ts",
          oldText: "before",
          newText: "after",
        },
      ],
    });

    expect(r.deltas).toEqual([{ type: "tool_use", content: "edit", toolId: "edit-1", toolName: "edit", input: "{\"path\":\"src/app.ts\"}" }]);
  });

  it("does not emit a block for incidental before/after fields", () => {
    const r = mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "search-1",
      title: "search",
      status: "completed",
      content: {
        type: "search_result",
        before: "cursor-a",
        after: "cursor-b",
        path: "pagination",
      },
    });

    expect(r.deltas).toEqual([{ type: "tool_result", content: "completed", toolId: "search-1" }]);
  });
});
