import { describe, it, expect } from "vitest"
import { joinStreamChunks } from "../stream-text"

describe("joinStreamChunks", () => {
  it("inserts a space when prev ends with sentence punctuation and chunk starts with a capital", () => {
    expect(joinStreamChunks("Delegating to the Platform Lead now.", "On it. I'll surface the rest."))
      .toBe("Delegating to the Platform Lead now. On it. I'll surface the rest.")
  })

  it("leaves chunks that already start with whitespace unchanged", () => {
    expect(joinStreamChunks("Done.", " Next up")).toBe("Done. Next up")
    expect(joinStreamChunks("Done.", "\nNext up")).toBe("Done.\nNext up")
  })

  it("leaves mid-word continuations unchanged when prev does not end with punctuation", () => {
    expect(joinStreamChunks("Delegat", "ing now")).toBe("Delegating now")
  })

  it("returns the chunk as-is when prev is empty", () => {
    expect(joinStreamChunks("", "Hello there.")).toBe("Hello there.")
  })

  it("inserts a space at an ellipsis boundary", () => {
    expect(joinStreamChunks("I'll surface…", "Meanwhile, the build runs."))
      .toBe("I'll surface… Meanwhile, the build runs.")
  })
})
