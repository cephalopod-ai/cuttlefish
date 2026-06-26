import { describe, expect, it } from "vitest";
import {
  resultAlreadyInStreamedBlocks,
  shouldPreserveStreamedBlocks,
} from "../streamed-blocks.js";

describe("streamed block persistence", () => {
  it("keeps tool-bearing turns consolidated to the final assistant message", () => {
    expect(
      shouldPreserveStreamedBlocks({
        quietPreempted: false,
        streamedBlocks: [
          { content: "PROGRESS-FIRST" },
          { content: "Used Bash", toolCall: "Bash" },
          { content: "PROGRESS-FINAL" },
        ],
      }),
    ).toBe(false);
  });

  it("keeps plain text-only turns consolidated to the final assistant message", () => {
    expect(
      shouldPreserveStreamedBlocks({
        quietPreempted: false,
        streamedBlocks: [{ content: "just streaming text" }],
      }),
    ).toBe(false);
  });

  it("drops streamed blocks from interrupted or superseded turns", () => {
    expect(
      shouldPreserveStreamedBlocks({
        quietPreempted: true,
        streamedBlocks: [
          { content: "old progress" },
          { content: "Using Bash", toolCall: "Bash" },
        ],
      }),
    ).toBe(false);
  });

  it("recognizes when the final result is already one streamed text block", () => {
    expect(
      resultAlreadyInStreamedBlocks("PROGRESS-FINAL", [
        { content: "PROGRESS-FIRST" },
        { content: "Used Bash", toolCall: "Bash" },
        { content: "PROGRESS-FINAL" },
      ]),
    ).toBe(true);

    expect(
      resultAlreadyInStreamedBlocks("PROGRESS-FINAL", [
        { content: "PROGRESS-FIRST" },
        { content: "Used Bash", toolCall: "Bash" },
      ]),
    ).toBe(false);
  });

  it("does not treat an earlier repeated progress block as the final answer", () => {
    expect(
      resultAlreadyInStreamedBlocks("same", [
        { content: "same" },
        { content: "Used Bash", toolCall: "Bash" },
        { content: "different final" },
      ]),
    ).toBe(false);
  });

  it("recognizes whole-turn results already represented by multiple streamed text blocks", () => {
    expect(
      resultAlreadyInStreamedBlocks("first final", [
        { content: "first" },
        { content: "Used Bash", toolCall: "Bash" },
        { content: "final" },
      ]),
    ).toBe(true);
  });
});
