/**
 * createTtsStart — gesture-time priming, streamed per-sentence playback (ordering
 * + lifecycle), pause-cancels-stream, Kokoro→Web-Speech fallback, markdown strip;
 * plus the length-prefixed frame reader.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { createTtsStart, createFrameReader, defaultTtsDeps, type TtsEngineDeps, type StreamPlayer } from "../tts-engine"

/* ── helpers ─────────────────────────────────────────────────────────────── */

function frame(s: string): Uint8Array {
  const body = new TextEncoder().encode(s)
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, false)
  out.set(body, 4)
  return out
}
function framesBytes(...ss: string[]): Uint8Array {
  const parts = ss.map(frame)
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
function streamOf(bytes: Uint8Array, chunkSize = 5): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(i, i + chunkSize))
      i += chunkSize
    },
  })
}
function decode(b: ArrayBuffer): string {
  return new TextDecoder().decode(b)
}
function cbs() {
  return { onPlaying: vi.fn(), onEnd: vi.fn(), onError: vi.fn() }
}

function mockPlayer() {
  let startCb = () => {}
  let idleCb = () => {}
  const enqueued: ArrayBuffer[] = []
  const p = {
    enqueueBuffer: vi.fn((b: ArrayBuffer) => enqueued.push(b)),
    onStart: (cb: () => void) => { startCb = cb },
    onIdle: (cb: () => void) => { idleCb = cb },
    reset: vi.fn(),
    playing: false,
    enqueued,
    fireStart: () => startCb(),
    fireIdle: () => idleCb(),
  }
  return p
}

function deps(over: Partial<TtsEngineDeps> = {}, player = mockPlayer()): { d: TtsEngineDeps; player: ReturnType<typeof mockPlayer>; signals: AbortSignal[] } {
  const signals: AbortSignal[] = []
  const d = {
    checkAvailable: vi.fn().mockResolvedValue(true),
    openStream: vi.fn(async (_t: string, sig: AbortSignal) => {
      signals.push(sig)
      return streamOf(framesBytes("One.", "Two.", "Three."))
    }),
    getPlayer: vi.fn(() => player as unknown as StreamPlayer),
    speak: vi.fn(() => () => {}),
    primeAudio: vi.fn(),
    ...over,
  } as TtsEngineDeps
  return { d, player, signals }
}

/** Let the background stream pump drain. */
async function flush(times = 12) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

/* ── frame reader ────────────────────────────────────────────────────────── */

describe("createFrameReader", () => {
  it("parses multiple whole frames in one chunk", () => {
    const r = createFrameReader()
    const out = r.push(framesBytes("ab", "cde"))
    expect(out.map(decode)).toEqual(["ab", "cde"])
  })

  it("buffers a split frame across chunks", () => {
    const r = createFrameReader()
    const bytes = framesBytes("hello")
    expect(r.push(bytes.slice(0, 3))).toEqual([]) // header not even complete
    expect(r.push(bytes.slice(3, 6))).toEqual([]) // body partial
    expect(r.push(bytes.slice(6)).map(decode)).toEqual(["hello"]) // completes
  })

  it("handles a chunk that ends mid-way through the next frame", () => {
    const r = createFrameReader()
    const bytes = framesBytes("aa", "bbbb")
    const out1 = r.push(bytes.slice(0, 9)) // first frame + part of second
    expect(out1.map(decode)).toEqual(["aa"])
    const out2 = r.push(bytes.slice(9))
    expect(out2.map(decode)).toEqual(["bbbb"])
  })
})

/* ── engine ──────────────────────────────────────────────────────────────── */

describe("createTtsStart (streaming)", () => {
  it("primes audio SYNCHRONOUSLY before any await (keeps the gesture window)", () => {
    const { d } = deps()
    void createTtsStart(d)("hello", cbs())
    expect(d.primeAudio).toHaveBeenCalledTimes(1)
  })

  it("strips markdown before opening the stream", async () => {
    const { d } = deps()
    await createTtsStart(d)("**Bold** and `code` and [link](http://x)", cbs())
    await flush()
    expect(d.openStream).toHaveBeenCalledWith("Bold and code and link", expect.any(AbortSignal))
  })

  it("enqueues each sentence frame IN ORDER on the player", async () => {
    const { d, player } = deps()
    await createTtsStart(d)("irrelevant", cbs())
    await flush()
    expect(player.enqueued.map(decode)).toEqual(["One.", "Two.", "Three."])
    expect(d.speak).not.toHaveBeenCalled()
  })

  it("fires onPlaying when the first frame starts, onEnd when drained after stream end", async () => {
    const { d, player } = deps()
    const c = cbs()
    await createTtsStart(d)("x", c)
    await flush() // stream fully read → streamDone
    expect(c.onPlaying).not.toHaveBeenCalled()
    player.fireStart()
    expect(c.onPlaying).toHaveBeenCalledTimes(1)
    expect(c.onEnd).not.toHaveBeenCalled()
    player.fireIdle()
    expect(c.onEnd).toHaveBeenCalledTimes(1)
  })

  it("pause/stop aborts the stream (cancels server synthesis) and resets the player", async () => {
    const { d, player, signals } = deps()
    const stop = await createTtsStart(d)("x", cbs())
    await flush()
    expect(signals[0].aborted).toBe(false)
    stop()
    expect(signals[0].aborted).toBe(true)
    expect(player.reset).toHaveBeenCalled()
  })

  it("after stop, late onStart/onIdle do nothing", async () => {
    const { d, player } = deps()
    const c = cbs()
    const stop = await createTtsStart(d)("x", c)
    await flush()
    stop()
    player.fireStart()
    player.fireIdle()
    expect(c.onPlaying).not.toHaveBeenCalled()
    expect(c.onEnd).not.toHaveBeenCalled()
  })

  it("falls back to Web Speech when Kokoro is unavailable — no stream opened", async () => {
    const { d } = deps({ checkAvailable: vi.fn().mockResolvedValue(false) })
    await createTtsStart(d)("hello", cbs())
    expect(d.openStream).not.toHaveBeenCalled()
    expect(d.speak).toHaveBeenCalledTimes(1)
  })

  it("falls back to Web Speech when opening the stream fails (e.g. 503)", async () => {
    const { d } = deps({ openStream: vi.fn().mockRejectedValue(new Error("tts 503")) })
    await createTtsStart(d)("hello", cbs())
    expect(d.speak).toHaveBeenCalledTimes(1)
  })

  it("falls back to Web Speech when the availability probe throws", async () => {
    const { d } = deps({ checkAvailable: vi.fn().mockRejectedValue(new Error("net")) })
    await createTtsStart(d)("hello", cbs())
    expect(d.openStream).not.toHaveBeenCalled()
    expect(d.speak).toHaveBeenCalledTimes(1)
  })

  it("ends cleanly (no stream / no speak) when there's nothing speakable", async () => {
    const { d } = deps()
    const c = cbs()
    await createTtsStart(d)("   \n  ", c)
    expect(c.onEnd).toHaveBeenCalledTimes(1)
    expect(d.openStream).not.toHaveBeenCalled()
    expect(d.speak).not.toHaveBeenCalled()
  })

  it("reports onError when the stream yields zero frames", async () => {
    const { d } = deps({
      openStream: vi.fn(async () => streamOf(new Uint8Array(0))),
    })
    const c = cbs()
    await createTtsStart(d)("x", c)
    await flush()
    expect(c.onError).toHaveBeenCalledTimes(1)
    expect(c.onEnd).not.toHaveBeenCalled()
  })
})

/* ── Web Speech fallback: pause must actually cancel speech ──────────────────── */

describe("defaultTtsDeps().speak (Web Speech fallback)", () => {
  const realSynth = (globalThis as { speechSynthesis?: unknown }).speechSynthesis
  const realUtt = (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance

  afterEach(() => {
    ;(globalThis as { speechSynthesis?: unknown }).speechSynthesis = realSynth
    ;(globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = realUtt
  })

  function installSynth() {
    const cancel = vi.fn()
    const speak = vi.fn()
    ;(globalThis as { speechSynthesis?: unknown }).speechSynthesis = { cancel, speak }
    ;(globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = class {
      text: string
      onstart: (() => void) | null = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(text: string) {
        this.text = text
      }
    }
    return { cancel, speak }
  }

  // Regression: the read-aloud pause toggle calls the returned stop() handle; for
  // the browser fallback that MUST cancel the active utterance (was: kept talking).
  it("stop() handle cancels the active speech synthesis utterance", () => {
    const { cancel, speak } = installSynth()
    const stop = defaultTtsDeps().speak("hello world", cbs())
    expect(speak).toHaveBeenCalledTimes(1)
    cancel.mockClear() // ignore the pre-speak clear cancel()
    stop()
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
