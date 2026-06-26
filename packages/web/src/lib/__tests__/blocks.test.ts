import { describe, expect, it } from "vitest"
import { applyBlockEnvelopeToMessages } from "../blocks"

describe("web chat block reducer", () => {
  it("puts, patches, and removes a block message by block id", () => {
    const put = applyBlockEnvelopeToMessages([], {
      op: "put",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
      },
    }, "Plan", 100);

    expect(put).toHaveLength(1);
    expect(put[0]?.blocks?.[0]?.payload).toEqual({
      items: [{ id: "a", text: "Read code", status: "running" }],
    });

    const patched = applyBlockEnvelopeToMessages(put, {
      op: "patch",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        status: "done",
        payload: { summary: "Complete" },
      },
    }, "Plan complete", 200);

    expect(patched).toHaveLength(1);
    expect(patched[0]?.content).toBe("Plan complete");
    expect(patched[0]?.blocks?.[0]?.status).toBe("done");
    expect(patched[0]?.blocks?.[0]?.payload).toEqual({
      items: [{ id: "a", text: "Read code", status: "running" }],
      summary: "Complete",
    });

    const removed = applyBlockEnvelopeToMessages(patched, {
      op: "remove",
      block: { id: "plan", type: "task-list", version: 1, payload: {} },
    }, "", 300);

    expect(removed).toEqual([]);
  });

  it("removing a block from a mixed message preserves text content", () => {
    const removed = applyBlockEnvelopeToMessages([{
      id: "m1",
      role: "assistant",
      content: "Keep this answer text",
      timestamp: 100,
      blocks: [{
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        payload: { items: [{ id: "a", text: "Read code" }] },
      }],
    }], {
      op: "remove",
      block: { id: "plan", type: "task-list", version: 1, payload: {} },
    }, "", 200);

    expect(removed).toHaveLength(1);
    expect(removed[0]?.content).toBe("Keep this answer text");
    expect(removed[0]?.blocks).toBeUndefined();
  });

  it("removing a reloaded synthetic block row deletes the whole row", () => {
    const removed = applyBlockEnvelopeToMessages([{
      id: "db-message-id",
      role: "assistant",
      content: "Plan",
      timestamp: 100,
      blocks: [{
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        payload: { items: [{ id: "a", text: "Read code" }] },
      }],
    }], {
      op: "remove",
      block: { id: "plan", type: "task-list", version: 1, payload: {} },
    }, "", 200);

    expect(removed).toEqual([]);
  });

  it("patching a block on a mixed message preserves text content", () => {
    const patched = applyBlockEnvelopeToMessages([{
      id: "m1",
      role: "assistant",
      content: "Keep this answer text",
      timestamp: 100,
      blocks: [{
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        payload: { items: [{ id: "a", text: "Read code" }] },
      }],
    }], {
      op: "patch",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        status: "done",
        payload: { summary: "Complete" },
      },
    }, "Plan complete", 200);

    expect(patched).toHaveLength(1);
    expect(patched[0]?.content).toBe("Keep this answer text");
    expect(patched[0]?.blocks?.[0]?.status).toBe("done");
  });

  it("does not attach a new block to previous plain assistant history", () => {
    const next = applyBlockEnvelopeToMessages([{
      id: "m1",
      role: "assistant",
      content: "Plan running.",
      timestamp: 100,
    }], {
      op: "put",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
      },
    }, "Plan", 200);

    expect(next).toHaveLength(2);
    expect(next[0]?.content).toBe("Plan running.");
    expect(next[0]?.blocks).toBeUndefined();
    expect(next[1]?.blocks?.[0]?.id).toBe("plan");
  });

  it("does not attach task-list blocks to tool-call messages", () => {
    const next = applyBlockEnvelopeToMessages([{
      id: "tool-1",
      role: "assistant",
      content: "Using search",
      timestamp: 100,
      toolCall: "search",
    }], {
      op: "put",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
      },
    }, "Plan", 200);

    expect(next).toHaveLength(2);
    expect(next[0]?.blocks).toBeUndefined();
    expect(next[1]?.blocks?.[0]?.id).toBe("plan");
  });
});
