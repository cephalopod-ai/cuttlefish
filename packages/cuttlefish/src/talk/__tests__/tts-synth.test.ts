/**
 * Standalone read-aloud synth helpers backing GET/POST /api/tts:
 *   - validateTtsText: request-body guard (trim / reject / length cap)
 *   - synthesizeText / ttsStatus: thin wrappers over the shared Kokoro engine
 */
import { describe, it, expect, afterEach, vi } from "vitest"
import {
  validateTtsText,
  synthesizeText,
  ttsStatus,
  splitTtsSentences,
  streamTtsSentences,
  TTS_MAX_CHARS,
  __setTalkTtsForTest,
} from "../tts-stream.js"

describe("validateTtsText", () => {
  it("rejects non-strings", () => {
    expect(validateTtsText(123)).toEqual({ ok: false, error: "text must be a string" })
    expect(validateTtsText(null)).toEqual({ ok: false, error: "text must be a string" })
    expect(validateTtsText(undefined)).toEqual({ ok: false, error: "text must be a string" })
  })

  it("rejects empty / whitespace-only", () => {
    expect(validateTtsText("")).toEqual({ ok: false, error: "text must be a non-empty string" })
    expect(validateTtsText("   \n\t ")).toEqual({ ok: false, error: "text must be a non-empty string" })
  })

  it("trims and accepts normal text", () => {
    expect(validateTtsText("  hello there  ")).toEqual({ ok: true, text: "hello there" })
  })

  it("caps over-long text at a word boundary (no mid-word cut)", () => {
    const r = validateTtsText("hello world foo bar baz", 12)
    expect(r).toEqual({ ok: true, text: "hello world" })
  })

  it("hard-slices a single giant token with no boundary", () => {
    const r = validateTtsText("a".repeat(100), 10)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe("a".repeat(10))
  })

  it("default cap is TTS_MAX_CHARS", () => {
    const long = "word ".repeat(5000) // ~25k chars
    const r = validateTtsText(long)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text.length).toBeLessThanOrEqual(TTS_MAX_CHARS)
      expect(r.text.endsWith("word")).toBe(true) // boundary cut keeps whole words
    }
  })
})

describe("synthesizeText / ttsStatus", () => {
  afterEach(() => __setTalkTtsForTest(null))

  it("synthesizeText delegates to the engine's synthesize()", async () => {
    const synthesize = vi.fn().mockResolvedValue(Buffer.from("RIFFWAVE"))
    __setTalkTtsForTest({ synthesize } as never)
    const buf = await synthesizeText("hello")
    expect(synthesize).toHaveBeenCalledWith("hello")
    expect(buf.toString()).toBe("RIFFWAVE")
  })

  it("synthesizeText propagates engine unavailability (→ 503 at the route)", async () => {
    const synthesize = vi.fn().mockRejectedValue(new Error("Kokoro TTS unavailable"))
    __setTalkTtsForTest({ synthesize } as never)
    await expect(synthesizeText("hi")).rejects.toThrow(/unavailable/)
  })

  it("ttsStatus maps available + voice from the engine status", () => {
    __setTalkTtsForTest({
      status: () => ({ available: true, downloading: false, progress: 0, voice: "af_heart", ready: true }),
    } as never)
    expect(ttsStatus()).toEqual({ available: true, voice: "af_heart" })

    __setTalkTtsForTest({
      status: () => ({ available: false, downloading: false, progress: 0, voice: "af_heart", ready: false }),
    } as never)
    expect(ttsStatus()).toEqual({ available: false, voice: "af_heart" })
  })
})

describe("splitTtsSentences", () => {
  it("splits on sentence terminators followed by whitespace", () => {
    expect(splitTtsSentences("Hello there. How are you? I am fine!")).toEqual([
      "Hello there.",
      "How are you?",
      "I am fine!",
    ])
  })

  it("splits on newlines (list items / paragraphs)", () => {
    expect(splitTtsSentences("First line\nSecond line\n\nThird")).toEqual([
      "First line",
      "Second line",
      "Third",
    ])
  })

  it("collapses inner whitespace and drops empties", () => {
    expect(splitTtsSentences("  A   sentence.\n\n\n  Next.  ")).toEqual(["A sentence.", "Next."])
  })

  it("keeps a terminator-less line as one chunk", () => {
    expect(splitTtsSentences("no terminator here")).toEqual(["no terminator here"])
  })

  it("does not split decimals (no whitespace after the dot)", () => {
    expect(splitTtsSentences("Pi is 3.14 exactly.")).toEqual(["Pi is 3.14 exactly."])
  })
})

describe("streamTtsSentences", () => {
  afterEach(() => __setTalkTtsForTest(null))

  it("synthesizes sentence-by-sentence IN ORDER, emitting a frame per sentence", async () => {
    const synthesize = vi.fn(async (s: string) => Buffer.from(`wav:${s}`))
    __setTalkTtsForTest({ synthesize } as never)
    const frames: string[] = []
    const n = await streamTtsSentences(
      "One. Two. Three.",
      undefined,
      (wav) => frames.push(wav.toString()),
      () => false,
    )
    expect(synthesize.mock.calls.map((c) => c[0])).toEqual(["One.", "Two.", "Three."])
    expect(frames).toEqual(["wav:One.", "wav:Two.", "wav:Three."])
    expect(n).toBe(3)
  })

  it("stops synthesizing the rest when cancelled (pause cancels in-flight synthesis)", async () => {
    const synthesize = vi.fn(async (s: string) => Buffer.from(`wav:${s}`))
    __setTalkTtsForTest({ synthesize } as never)
    const frames: string[] = []
    let cancelled = false
    // Cancel right after the first frame is emitted.
    const n = await streamTtsSentences(
      "One. Two. Three. Four.",
      undefined,
      (wav) => {
        frames.push(wav.toString())
        cancelled = true
      },
      () => cancelled,
    )
    // Frame 1 emitted; the post-frame cancel check halts before synthesizing #2.
    expect(frames).toEqual(["wav:One."])
    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(n).toBe(1)
  })

  it("emits nothing for empty/whitespace input", async () => {
    const synthesize = vi.fn()
    __setTalkTtsForTest({ synthesize } as never)
    const frames: Buffer[] = []
    const n = await streamTtsSentences("   \n  ", undefined, (w) => frames.push(w), () => false)
    expect(n).toBe(0)
    expect(synthesize).not.toHaveBeenCalled()
  })
})
