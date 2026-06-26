/**
 * stripMarkdown — drops markdown syntax, preserves newlines for sentence splits.
 */
import { describe, it, expect } from "vitest"
import { stripMarkdown } from "../strip-markdown"

describe("stripMarkdown", () => {
  it("strips headings", () => {
    expect(stripMarkdown("## Hello there")).toBe("Hello there")
    expect(stripMarkdown("###### Deep")).toBe("Deep")
  })

  it("strips PAIRED bold/italic markers that wrap content", () => {
    expect(stripMarkdown("**bold** and _italic_ and ***both***")).toBe(
      "bold and italic and both",
    )
    expect(stripMarkdown("say *hi* now")).toBe("say hi now")
  })

  it("preserves double-underscore tokens (dunder collision)", () => {
    // __x__ is indistinguishable from a dunder identifier, so it's left intact —
    // code/voice fidelity beats rare __bold__ prose emphasis.
    expect(stripMarkdown("the __init__ method")).toBe("the __init__ method")
    expect(stripMarkdown("__strong__")).toBe("__strong__")
  })

  it("does NOT mangle code, math, or URLs (TTS fidelity)", () => {
    // Identifiers / snake_case / dunder must survive — they're read aloud now.
    expect(stripMarkdown("call my_func and __init__ in some_file_name.ts")).toBe(
      "call my_func and __init__ in some_file_name.ts",
    )
    // Spaced math operators are not emphasis.
    expect(stripMarkdown("compute 2 * 3 * 4 today")).toBe("compute 2 * 3 * 4 today")
    // URL underscores survive.
    expect(stripMarkdown("see https://x.com/a_b_c/page now")).toBe(
      "see https://x.com/a_b_c/page now",
    )
  })

  it("strips list markers at line start", () => {
    expect(stripMarkdown("- one\n- two")).toBe("one\ntwo")
    expect(stripMarkdown("1. first\n2) second")).toBe("first\nsecond")
    expect(stripMarkdown("• bullet")).toBe("bullet")
  })

  it("strips blockquotes, inline code, and code fences", () => {
    expect(stripMarkdown("> quoted")).toBe("quoted")
    expect(stripMarkdown("run `npm test` now")).toBe("run npm test now")
    expect(stripMarkdown("```ts\ncode\n```")).toBe("code")
  })

  it("strips fence info strings with non-word chars", () => {
    expect(stripMarkdown("```c++\nx\n```")).toBe("x")
    expect(stripMarkdown('```ts title="x"\ny\n```')).toBe("y")
  })

  it("turns links into their label text", () => {
    expect(stripMarkdown("see [the docs](https://x.com/y)")).toBe("see the docs")
  })

  it("preserves newlines but collapses horizontal whitespace", () => {
    expect(stripMarkdown("a    b\n\n\nc   d")).toBe("a b\n\nc d")
  })

  it("leaves plain text untouched (trimmed)", () => {
    expect(stripMarkdown("  Just plain text.  ")).toBe("Just plain text.")
  })
})
