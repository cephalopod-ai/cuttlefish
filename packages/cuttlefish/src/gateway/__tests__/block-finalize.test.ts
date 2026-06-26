import { describe, expect, it } from "vitest";
import type { StreamDelta } from "../../shared/types.js";
import { finalBlocksForAssistantMessage, normalizeBlockDeltaForTurn, shouldPersistFinalAssistantMessage } from "../api.js";

describe("block finalization", () => {
  it("persists the final assistant row when the turn produced text", () => {
    expect(shouldPersistFinalAssistantMessage({
      resultText: "Done.",
      finalBlockCount: 0,
      resultAlreadyPersisted: false,
      quietPreempted: false,
    })).toBe(true);
  });

  it("persists a blocks-only final row when the turn produced no text", () => {
    expect(shouldPersistFinalAssistantMessage({
      resultText: "",
      finalBlockCount: 1,
      resultAlreadyPersisted: false,
      quietPreempted: false,
    })).toBe(true);
  });

  it("does not persist preempted or already persisted turns", () => {
    expect(shouldPersistFinalAssistantMessage({
      resultText: "Done.",
      finalBlockCount: 1,
      resultAlreadyPersisted: true,
      quietPreempted: false,
    })).toBe(false);
    expect(shouldPersistFinalAssistantMessage({
      resultText: "Done.",
      finalBlockCount: 1,
      resultAlreadyPersisted: false,
      quietPreempted: true,
    })).toBe(false);
  });

  it("excludes already persisted blocks from the final assistant row", () => {
    expect(finalBlocksForAssistantMessage([
      { id: "plan", type: "task-list", version: 1, payload: {} },
      { id: "progress", type: "task-list", version: 1, payload: {} },
    ], new Set(["progress"])).map((block) => block.id)).toEqual(["plan"]);
  });

  it("drops malformed block deltas before scoping ids", () => {
    const result = normalizeBlockDeltaForTurn({
      type: "block",
      block: { op: "put", block: { type: "task-list", version: 1, payload: { items: [] } } },
    } as unknown as StreamDelta, 1_700_000_000_000);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("block id");
  });

  it("scopes valid block ids to the current turn", () => {
    const result = normalizeBlockDeltaForTurn({
      type: "block",
      content: "",
      block: {
        op: "put",
        block: {
          id: "plan",
          type: "task-list",
          version: 1,
          payload: { items: [{ id: "a", text: "Read code" }] },
        },
      },
    }, 1_700_000_000_000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delta.block?.block.id).toMatch(/^plan:t/);
      expect(result.delta.content).toBe("task-list: 1 item");
    }
  });
});
