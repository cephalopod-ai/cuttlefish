/**
 * Cuttlefish Talk — TalkAudioPlayer tests (turn-boundary re-arm + suspended-context resume).
 *
 * jsdom has no WebAudio, so we install a minimal fake AudioContext that records
 * scheduled buffer sources and resume() calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { TalkAudioPlayer } from "../audio-player"

// Ordered log of lifecycle events, to assert resume-before-start across turns.
const events: string[] = []

class FakeBufferSource {
  buffer: unknown = null
  onended: (() => void) | null = null
  started = false
  stopped = false
  start = vi.fn((_when?: number) => {
    this.started = true
    events.push("start")
  })
  stop = vi.fn((_when?: number) => {
    this.stopped = true
    events.push("stop")
  })
  connect = vi.fn(() => {})
  disconnect = vi.fn(() => {})
}

class FakeAudioContext {
  state: "running" | "suspended" | "closed"
  currentTime = 0
  sources: FakeBufferSource[] = []
  resume = vi.fn(async () => {
    // Resolve on a real timer so a fire-and-forget (un-awaited) resume would let
    // start() run first — the awaited path must order "resume" before "start".
    await new Promise((r) => setTimeout(r, 5))
    this.state = "running"
    events.push("resume")
  })
  close = vi.fn(async () => {
    this.state = "closed"
  })
  constructor(initial: "running" | "suspended" = "running") {
    this.state = initial
    FakeAudioContext.last = this
  }
  static last: FakeAudioContext | null = null
  static initialState: "running" | "suspended" = "running"
  createAnalyser() {
    return { fftSize: 0, smoothingTimeConstant: 0, connect: vi.fn() } as unknown as AnalyserNode
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn() } as unknown as GainNode
  }
  createBufferSource() {
    const s = new FakeBufferSource()
    this.sources.push(s)
    return s as unknown as AudioBufferSourceNode
  }
  async decodeAudioData(_data: ArrayBuffer): Promise<AudioBuffer> {
    return { duration: 0.1 } as unknown as AudioBuffer
  }
}

// A tiny valid base64 payload (decode is faked, so contents don't matter).
const B64 = btoa("wavchunk")

/** Drain the player's internal decode/resume promise chain. */
async function settle(player: TalkAudioPlayer) {
  for (let i = 0; i < 5; i++) {
    await (player as unknown as { chain: Promise<void> }).chain
    await Promise.resolve()
  }
}

beforeEach(() => {
  ;(window as unknown as { AudioContext: unknown }).AudioContext = function (this: unknown) {
    return new FakeAudioContext(FakeAudioContext.initialState)
  } as unknown as typeof AudioContext
  FakeAudioContext.last = null
  FakeAudioContext.initialState = "running"
  events.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("TalkAudioPlayer turn boundaries", () => {
  it("schedules a new turn's first frame after the previous turn's last:true", async () => {
    const player = new TalkAudioPlayer()
    // Turn 1: two frames, the second carries last:true.
    player.enqueue(0, "audio/wav", B64, false)
    player.enqueue(1, "audio/wav", B64, true)
    // Turn 2: first frame (seq resets to 0) — must NOT be stuck behind the latch.
    player.enqueue(0, "audio/wav", B64, false)
    await settle(player)

    const ctx = FakeAudioContext.last!
    // All three frames got scheduled for playback (each calls source.start once).
    expect(ctx.sources).toHaveLength(3)
    for (const s of ctx.sources) expect(s.start).toHaveBeenCalledTimes(1)
    expect(player.playing).toBe(true)
  })

  it("resumes a suspended context (awaited) before scheduling", async () => {
    FakeAudioContext.initialState = "suspended"
    const player = new TalkAudioPlayer()
    player.enqueue(0, "audio/wav", B64, true) // turn 1 (single frame)
    player.enqueue(0, "audio/wav", B64, false) // turn 2 first frame
    await settle(player)

    const ctx = FakeAudioContext.last!
    expect(ctx.resume).toHaveBeenCalled()
    expect(ctx.state).toBe("running")
    // Both frames scheduled despite starting suspended.
    expect(ctx.sources).toHaveLength(2)
    for (const s of ctx.sources) expect(s.start).toHaveBeenCalledTimes(1)
    // The resume was AWAITED: it resolved before any frame was scheduled (a
    // fire-and-forget resume would let "start" precede "resume").
    expect(events[0]).toBe("resume")
    expect(events.filter((e) => e === "start")).toHaveLength(2)
  })

  it("goes idle after a turn drains, then re-arms for the next turn", async () => {
    const player = new TalkAudioPlayer()
    const idle = vi.fn()
    player.onIdle(idle)

    player.enqueue(0, "audio/wav", B64, true) // single-frame turn 1
    await settle(player)
    const ctx = FakeAudioContext.last!
    // Simulate playback finishing.
    ctx.sources[0].onended?.()
    expect(idle).toHaveBeenCalledTimes(1)
    expect(player.playing).toBe(false)

    // Next turn arrives after idle — re-arms and schedules.
    player.enqueue(0, "audio/wav", B64, false)
    await settle(player)
    expect(ctx.sources).toHaveLength(2)
    expect(ctx.sources[1].start).toHaveBeenCalledTimes(1)
    expect(player.playing).toBe(true)
  })

  // Regression: read-aloud / talk "pause" must actually silence audio. A pause
  // routes through reset(); before the fix reset() cleared the queue but left
  // already-scheduled sources playing to completion ("pause keeps playing").
  it("reset() stops every scheduled/playing source (pause is immediate)", async () => {
    const player = new TalkAudioPlayer()
    player.enqueue(0, "audio/wav", B64, false)
    player.enqueue(1, "audio/wav", B64, false)
    player.enqueue(2, "audio/wav", B64, true)
    await settle(player)

    const ctx = FakeAudioContext.last!
    expect(ctx.sources).toHaveLength(3)
    for (const s of ctx.sources) expect(s.start).toHaveBeenCalledTimes(1)
    expect(player.playing).toBe(true)

    // Pause: every committed source must be stopped (not left to drain).
    player.reset()
    for (const s of ctx.sources) {
      expect(s.stop).toHaveBeenCalledTimes(1)
      expect(s.disconnect).toHaveBeenCalledTimes(1)
    }
    expect(player.playing).toBe(false)

    // A late onended from a stopped source must not flip idle/bookkeeping back on
    // (onended is detached before stop, so calling it is a no-op for state).
    ctx.sources[0].onended?.()
    expect(player.playing).toBe(false)
  })
})
