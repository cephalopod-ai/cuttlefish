/**
 * TtsController — single-active read-aloud state machine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { TtsController, type TtsStartCallbacks } from "../tts-controller"

/**
 * A controllable mock `start`: each call records its callbacks + a stop spy and
 * exposes a `resolve()` to complete the (async) start at a chosen moment.
 */
function makeMockStart() {
  const calls: Array<{
    text: string
    cbs: TtsStartCallbacks
    stop: ReturnType<typeof vi.fn>
    resolve: () => void
  }> = []
  const start = vi.fn((text: string, cbs: TtsStartCallbacks) => {
    const stop = vi.fn()
    let resolveFn!: () => void
    const promise = new Promise<() => void>((res) => {
      resolveFn = () => res(stop)
    })
    calls.push({ text, cbs, stop, resolve: resolveFn })
    return promise
  })
  return { start, calls }
}

describe("TtsController", () => {
  let snapshots: Array<{ id: string | null; phase: string }>
  let unsub: () => void

  function track(ctrl: TtsController) {
    snapshots = [{ ...ctrl.getSnapshot() }]
    unsub = ctrl.subscribe(() => snapshots.push({ ...ctrl.getSnapshot() }))
  }

  beforeEach(() => {
    snapshots = []
  })

  it("goes idle → loading → playing on toggle", async () => {
    const { start, calls } = makeMockStart()
    const ctrl = new TtsController(start)
    track(ctrl)

    ctrl.toggle("a", "hello")
    expect(ctrl.phaseFor("a")).toBe("loading")

    calls[0].resolve()
    await Promise.resolve()
    await Promise.resolve()
    calls[0].cbs.onPlaying()

    expect(ctrl.phaseFor("a")).toBe("playing")
    expect(ctrl.getSnapshot()).toEqual({ id: "a", phase: "playing" })
    expect(snapshots.map((s) => s.phase)).toEqual(["idle", "loading", "playing"])
    unsub()
  })

  it("toggling the active message pauses it (→ idle)", async () => {
    const { start, calls } = makeMockStart()
    const ctrl = new TtsController(start)
    ctrl.toggle("a", "hello")
    calls[0].resolve()
    await Promise.resolve()
    calls[0].cbs.onPlaying()
    expect(ctrl.phaseFor("a")).toBe("playing")

    ctrl.toggle("a", "hello") // second click = pause
    expect(ctrl.phaseFor("a")).toBe("idle")
    expect(calls[0].stop).toHaveBeenCalledTimes(1)
  })

  it("enforces a single active message — starting B stops A", async () => {
    const { start, calls } = makeMockStart()
    const ctrl = new TtsController(start)

    ctrl.toggle("a", "first")
    calls[0].resolve()
    await Promise.resolve()
    calls[0].cbs.onPlaying()
    expect(ctrl.phaseFor("a")).toBe("playing")

    ctrl.toggle("b", "second")
    expect(calls[0].stop).toHaveBeenCalledTimes(1) // A was stopped
    expect(ctrl.phaseFor("a")).toBe("idle")
    expect(ctrl.phaseFor("b")).toBe("loading")

    calls[1].resolve()
    await Promise.resolve()
    calls[1].cbs.onPlaying()
    expect(ctrl.getSnapshot()).toEqual({ id: "b", phase: "playing" })
  })

  it("resets to idle when playback ends naturally", async () => {
    const { start, calls } = makeMockStart()
    const ctrl = new TtsController(start)
    ctrl.toggle("a", "hello")
    calls[0].resolve()
    await Promise.resolve()
    calls[0].cbs.onPlaying()
    calls[0].cbs.onEnd()
    expect(ctrl.phaseFor("a")).toBe("idle")
  })

  it("resets to idle when playback errors", async () => {
    const { start, calls } = makeMockStart()
    const ctrl = new TtsController(start)
    ctrl.toggle("a", "hello")
    calls[0].resolve()
    await Promise.resolve()
    calls[0].cbs.onError()
    expect(ctrl.phaseFor("a")).toBe("idle")
  })

  it("resets to idle when start() rejects", async () => {
    const start = vi.fn().mockRejectedValue(new Error("boom"))
    const ctrl = new TtsController(start)
    ctrl.toggle("a", "hello")
    await Promise.resolve()
    await Promise.resolve()
    expect(ctrl.phaseFor("a")).toBe("idle")
  })

  it("supersedes a start that resolves after a newer toggle (stops the stale one)", async () => {
    const { start, calls } = makeMockStart()
    const ctrl = new TtsController(start)

    ctrl.toggle("a", "first") // start A pending
    ctrl.toggle("b", "second") // newer start before A resolved

    // Now A resolves late — it must be stopped, not adopted.
    calls[0].resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls[0].stop).toHaveBeenCalledTimes(1)
    expect(ctrl.phaseFor("a")).toBe("idle")

    calls[1].resolve()
    await Promise.resolve()
    calls[1].cbs.onPlaying()
    expect(ctrl.phaseFor("b")).toBe("playing")
  })

  it("stale callbacks from a superseded message are ignored", async () => {
    const { start, calls } = makeMockStart()
    const ctrl = new TtsController(start)
    ctrl.toggle("a", "first")
    calls[0].resolve()
    await Promise.resolve()
    calls[0].cbs.onPlaying()

    ctrl.toggle("b", "second") // A stopped, B loading

    // A late "onPlaying" from A must not flip the snapshot back to A.
    calls[0].cbs.onPlaying()
    expect(ctrl.getSnapshot().id).toBe("b")
  })

  it("stop() halts active playback and returns to idle", async () => {
    const { start, calls } = makeMockStart()
    const ctrl = new TtsController(start)
    ctrl.toggle("a", "hello")
    calls[0].resolve()
    await Promise.resolve()
    calls[0].cbs.onPlaying()

    ctrl.stop()
    expect(calls[0].stop).toHaveBeenCalledTimes(1)
    expect(ctrl.getSnapshot()).toEqual({ id: null, phase: "idle" })
  })
})
