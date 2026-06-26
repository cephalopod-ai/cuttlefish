/**
 * Cuttlefish Talk — splitSentences tests (pure helper behind sentence-synced captions).
 */
import { describe, it, expect } from "vitest"
import { splitSentences } from "../use-speak"

describe("splitSentences", () => {
  it("splits a multi-sentence string keeping terminators", () => {
    expect(splitSentences("Hello world. How are you? Great!")).toEqual([
      "Hello world.",
      "How are you?",
      "Great!",
    ])
  })

  it("keeps trailing text that has no terminator", () => {
    expect(splitSentences("Done. Now the trailing bit")).toEqual([
      "Done.",
      "Now the trailing bit",
    ])
  })

  it("returns a single sentence unchanged", () => {
    expect(splitSentences("Just one sentence")).toEqual(["Just one sentence"])
  })

  it("returns an empty array for empty / whitespace input", () => {
    expect(splitSentences("")).toEqual([])
    expect(splitSentences("   \n  ")).toEqual([])
  })

  it("splits on newlines", () => {
    expect(splitSentences("Line one\nLine two")).toEqual(["Line one", "Line two"])
  })

  it("groups consecutive terminators (?! and ellipsis)", () => {
    expect(splitSentences("Really?! Wait...")).toEqual(["Really?!", "Wait..."])
    expect(splitSentences("Hmm… ok.")).toEqual(["Hmm…", "ok."])
  })

  it("does not split inside a decimal number", () => {
    expect(splitSentences("Pi is 3.14 today.")).toEqual(["Pi is 3.14 today."])
  })
})
