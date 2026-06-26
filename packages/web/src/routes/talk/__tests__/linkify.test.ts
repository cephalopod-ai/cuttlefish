import { describe, it, expect } from "vitest"
import { splitLinks } from "../linkify"

describe("splitLinks", () => {
  it("splits bare URLs out of prose", () => {
    expect(splitLinks("see https://example.com/x?a=1 for more")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", url: "https://example.com/x?a=1", text: "example.com/x?a=1" },
      { kind: "text", text: " for more" },
    ])
  })
  it("passes through plain text and trims trailing punctuation off the URL", () => {
    expect(splitLinks("no links here")).toEqual([{ kind: "text", text: "no links here" }])
    const segs = splitLinks("go to https://a.bc/d.")
    expect(segs[1]).toEqual({ kind: "link", url: "https://a.bc/d", text: "a.bc/d" })
    expect(segs[2]).toEqual({ kind: "text", text: "." })
  })
  it("keeps offsets aligned across multiple URLs in one string", () => {
    expect(splitLinks("a https://x.y/p. b https://z.w c")).toEqual([
      { kind: "text", text: "a " },
      { kind: "link", url: "https://x.y/p", text: "x.y/p" },
      { kind: "text", text: ". b " },
      { kind: "link", url: "https://z.w", text: "z.w" },
      { kind: "text", text: " c" },
    ])
  })
  it("trims unicode trailing punctuation (ellipsis, em-dash)", () => {
    expect(splitLinks("see https://a.bc/d…")[1]).toEqual({ kind: "link", url: "https://a.bc/d", text: "a.bc/d" })
  })
})
