import { describe, it, expect } from "vitest";
import { toSpeakable } from "../speakable.js";

describe("toSpeakable", () => {
  it("strips bold markers", () => {
    expect(toSpeakable("**Bold claim** stands")).toBe("Bold claim stands");
  });

  it("strips em, underline, and inline code", () => {
    expect(toSpeakable(`*em* and _under_ and \`code\``)).toBe("em and under and code");
  });

  it("drops heading and bullet markers, joins lines with space", () => {
    expect(toSpeakable("# Heading\n- bullet one")).toBe("Heading bullet one");
  });

  it("converts markdown link to link text only", () => {
    expect(toSpeakable("see [the doc](https://x.y/z)")).toBe("see the doc");
  });

  it("replaces bare URL with 'the link on screen'", () => {
    expect(toSpeakable("open https://example.com/path?q=1 now")).toBe(
      "open the link on screen now",
    );
  });

  it("removes UUIDs and collapses surrounding whitespace", () => {
    expect(
      toSpeakable("session 94f97239-b6ab-4101-8e37-48814246d7c1 done"),
    ).toBe("session done");
  });

  it("removes machine tags (card-action)", () => {
    expect(toSpeakable("ok [card-action card=x action=approve] done")).toBe("ok done");
  });

  it("removes bare hex strings >= 12 chars", () => {
    expect(toSpeakable("commit deadbeefcafe123 deployed")).toBe("commit deployed");
  });

  it("removes [Route this ...] machine tags", () => {
    expect(toSpeakable('ok [Route this to the existing "x" COO thread: session abc] done')).toBe("ok done");
  });

  it("removes entire fenced code block, leaving empty string", () => {
    expect(toSpeakable("```js\ncode\n```")).toBe("");
  });

  it("passes plain conversational text through byte-identical", () => {
    const plain = "Two posts went out this morning, both look clean.";
    expect(toSpeakable(plain)).toBe(plain);
  });
});
