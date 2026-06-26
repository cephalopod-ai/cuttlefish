import { describe, it, expect, vi, beforeEach } from "vitest"
import { extractSentences, feedTalkText, flushTalkSpeech, discardTalkSpeech, __setTalkTtsForTest } from "../tts-stream.js"

describe("extractSentences", () => {
  it("extracts complete sentences, keeps the incomplete remainder", () => {
    expect(extractSentences("Hello there. How are")).toEqual({ complete: ["Hello there."], rest: "How are" })
  })
  it("requires whitespace after the terminator (decimals survive)", () => {
    expect(extractSentences("Pi is 3.14 and counting")).toEqual({ complete: [], rest: "Pi is 3.14 and counting" })
  })
  it("handles multiple sentences and newlines", () => {
    const r = extractSentences("One. Two!\nThree? Four")
    expect(r.complete).toEqual(["One.", "Two!", "Three?"])
    expect(r.rest).toBe("Four")
  })
})

describe("per-sentence streaming", () => {
  const speak = vi.fn(async (_sid: string, text: string, _emit: unknown, opts?: { seqStart?: number; final?: boolean }) => {
    void text; void opts
    return 1 // pretend each call emits exactly 1 chunk
  })
  beforeEach(() => {
    speak.mockClear()
    __setTalkTtsForTest({ speak } as never)
  })

  it("synthesizes each completed sentence as it arrives, monotonic seq, final only on flush", async () => {
    const emit = vi.fn()
    feedTalkText("s1", "Hello there. How ", undefined, emit)
    feedTalkText("s1", "are you? I am", undefined, emit)
    await flushTalkSpeech("s1", undefined, emit)
    expect(speak).toHaveBeenCalledTimes(3)
    expect(speak.mock.calls[0][1]).toBe("Hello there.")
    expect(speak.mock.calls[0][3]).toEqual({ seqStart: 0, final: false })
    expect(speak.mock.calls[1][1]).toBe("How are you?")
    expect(speak.mock.calls[1][3]).toEqual({ seqStart: 1, final: false })
    expect(speak.mock.calls[2][1]).toBe("I am")
    expect(speak.mock.calls[2][3]).toEqual({ seqStart: 2, final: true })
  })

  it("discard drops buffered + not-yet-synthesized text", async () => {
    const emit = vi.fn()
    feedTalkText("s2", "One. Two", undefined, emit)
    discardTalkSpeech("s2")
    await flushTalkSpeech("s2", undefined, emit)
    // Let the stranded chain task (queued "One.") run — the epoch guard must drop it.
    await new Promise((r) => setTimeout(r, 0))
    expect(speak.mock.calls.filter((c) => c[0] === "s2")).toHaveLength(0)
  })

  it("advances seq by the actual chunk count when kokoro re-splits a sentence", async () => {
    const emit = vi.fn()
    speak.mockImplementationOnce(async () => 2) // first sentence yields 2 chunks
    feedTalkText("s4", "Hello\nthere. Next one. Tail", undefined, emit)
    await flushTalkSpeech("s4", undefined, emit)
    expect(speak).toHaveBeenCalledTimes(3)
    expect(speak.mock.calls[0][3]).toEqual({ seqStart: 0, final: false })
    expect(speak.mock.calls[1][3]).toEqual({ seqStart: 2, final: false }) // +2, not +1
    expect(speak.mock.calls[2][3]).toEqual({ seqStart: 3, final: true })
  })

  it("without emit (legacy buffering) everything speaks on flush", async () => {
    const emit = vi.fn()
    feedTalkText("s3", "Alpha. Beta.")
    await flushTalkSpeech("s3", undefined, emit)
    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak.mock.calls[0][1]).toBe("Alpha. Beta.")
    expect(speak.mock.calls[0][3]).toEqual({ seqStart: 0, final: true })
  })
})

describe("speech sanitization in queueSentence", () => {
  const speak = vi.fn(async (_sid: string, _text: string, _emit: unknown, _opts?: unknown) => 1)
  beforeEach(() => {
    speak.mockClear()
    __setTalkTtsForTest({ speak } as never)
  })

  it("sanitizes markdown before speaking: **Done.** → Done.", async () => {
    const emit = vi.fn()
    // No trailing whitespace after the period → stays buffered → spoken via flush
    feedTalkText("san1", "**Done.**", undefined, emit)
    await flushTalkSpeech("san1", undefined, emit)
    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak.mock.calls[0][1]).toBe("Done.")
  })

  it("sanitizes sentence to empty (UUID remainder) → zero speak calls", async () => {
    const emit = vi.fn()
    // A bare UUID with no terminator stays in the buffer as remainder.
    feedTalkText("san2", "94f97239-b6ab-4101-8e37-48814246d7c1", undefined, emit)
    await flushTalkSpeech("san2", undefined, emit)
    expect(speak).not.toHaveBeenCalled()
  })
})

describe("per-turn serialization (audio-death race)", () => {
  // Record (text, opts, started-at, resolved-at) for every speak call. The first
  // call is SLOW (50ms) so a second turn fired before it resolves would, without
  // serialization, start its own chain and interleave audio events.
  interface Rec { text: string; opts: { seqStart?: number; final?: boolean }; start: number; end: number }
  let recs: Rec[]
  const speak = vi.fn(
    async (_sid: string, text: string, _emit: unknown, opts?: { seqStart?: number; final?: boolean }) => {
      const rec: Rec = { text, opts: opts ?? {}, start: performance.now(), end: 0 }
      recs.push(rec)
      const delay = recs.length === 1 ? 50 : 1
      await new Promise((r) => setTimeout(r, delay))
      rec.end = performance.now()
      return 1
    },
  )
  beforeEach(() => {
    recs = []
    speak.mockClear()
    __setTalkTtsForTest({ speak } as never)
  })

  it("turn N's last:true resolves before turn N+1's first speak starts", async () => {
    const emit = vi.fn()
    // Turn 1 (no trailing whitespace → stays buffered → spoken with final:true on flush).
    feedTalkText("t", "First sentence.", undefined, emit)
    const flush1 = flushTalkSpeech("t", undefined, emit) // do NOT await
    // Turn 2 fires immediately, while turn 1's slow synth is still pending.
    feedTalkText("t", "Second sentence.", undefined, emit)
    await flushTalkSpeech("t", undefined, emit)
    await flush1

    // (a) call order is exactly First then Second.
    expect(recs.map((r) => r.text)).toEqual(["First sentence.", "Second sentence."])
    // (a) the second call STARTS only after the first RESOLVES.
    expect(recs[1].start).toBeGreaterThanOrEqual(recs[0].end)
    // (b) turn 1's call carried final:true (it was the turn's last chunk).
    expect(recs[0].opts.final).toBe(true)
    // both turns are fresh → each restarts seq at 0.
    expect(recs[0].opts.seqStart).toBe(0)
    expect(recs[1].opts.seqStart).toBe(0)

    // (c) state is empty afterwards: a fresh feed+flush works normally from seq 0.
    recs = []
    speak.mockClear()
    feedTalkText("t", "Third.", undefined, emit)
    await flushTalkSpeech("t", undefined, emit)
    expect(speak).toHaveBeenCalledTimes(1)
    expect(recs[0].text).toBe("Third.")
    expect(recs[0].opts).toEqual({ seqStart: 0, final: true })
  })
})
