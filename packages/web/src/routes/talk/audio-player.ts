/**
 * Cuttlefish Talk — streamed audio player (Phase 2 real loop).
 *
 * Plays base64-encoded audio chunks (a complete WAV per sentence from the local
 * Kokoro TTS backend) IN ARRIVAL ORDER with low latency, and exposes an
 * AnalyserNode so the AURA orb can react to the REAL output audio (RMS level)
 * while it speaks.
 *
 * Design:
 *  - One shared AudioContext (created lazily, resumed on the first user gesture).
 *  - Each `talk:audio` frame is a SELF-CONTAINED WAV. `seq` is monotonic WITHIN a
 *    turn (it counts up from each speak's `seqStart`), and `last:true` rides only
 *    the turn's FINAL frame. We don't gate playback on `seq` — frames arrive in
 *    order over a single WS connection, so we play them in arrival order — but we
 *    DO watch `last` to re-arm cleanly at the turn boundary (a frame after a
 *    `last:true` is turn N+1's first frame: reset the drained-run latch and
 *    resume a suspended context before scheduling it).
 *  - Decode + schedule is serialized on a promise chain so the moving "playhead"
 *    clock stays correct and chunks are scheduled back-to-back with no gaps,
 *    clicks, or overlaps — regardless of how fast each chunk decodes.
 *  - Every source routes through a single AnalyserNode → destination, giving the
 *    page a continuous signal to read regardless of which chunk is playing.
 *  - `onIdle` fires once the queue fully drains (used to settle the avatar).
 *
 * Decode errors are swallowed per-chunk (we skip the bad chunk) so playback
 * never stalls on one corrupt frame.
 */

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export class TalkAudioPlayer {
  private ctx: AudioContext | null = null
  private analyserNode: AnalyserNode | null = null
  private gain: GainNode | null = null
  /** False when the ctx was supplied externally (shared) — don't close it on dispose. */
  private ownsCtx = true
  /** Fired once when the first buffer of a run actually starts playing. */
  private startCb: (() => void) | null = null
  private startNotified = false

  /**
   * @param externalCtx Optional pre-created (and gesture-resumed) AudioContext to
   *   share — e.g. the chat read-aloud primes one in the click gesture and passes
   *   it here so playback is autoplay-unlocked. When omitted, the player creates
   *   and owns its own context (the /talk usage).
   */
  constructor(externalCtx?: AudioContext) {
    if (externalCtx) {
      this.ctx = externalCtx
      this.ownsCtx = false
    }
  }

  /** Serializes decode+schedule so arrival order and the playhead stay correct. */
  private chain: Promise<void> = Promise.resolve()
  /** Have we started a fresh playback run (to anchor the playhead)? */
  private started = false

  /** Absolute AudioContext time at which the next buffer should start. */
  private playhead = 0
  /** Count of buffers currently scheduled / playing. */
  private activeSources = 0
  /**
   * Live references to every scheduled/playing BufferSource so `reset()` can
   * actually halt them. Without this, `source.start(...)` is fire-and-forget and
   * a pause/stop would clear the queue but let already-committed sources play to
   * completion (the "pause keeps playing" bug).
   */
  private liveSources = new Set<AudioBufferSourceNode>()
  /** Chunks accepted but not yet decoded/scheduled (sitting in the chain). */
  private inFlight = 0
  /** True between the first enqueue and the queue fully draining. */
  private _playing = false
  /** Set when a `last:true` frame is accepted; the next frame re-arms a fresh run. */
  private ended = false

  private idleCb: (() => void) | null = null
  /** Reused RMS scratch buffer for the level getter. */
  private rmsBuf: Uint8Array<ArrayBuffer> | null = null

  /** Lazily build the analyser graph (on a supplied or freshly-created context). */
  private ensureContext(): AudioContext {
    if (this.ctx && this.analyserNode) return this.ctx
    const Ctor: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    const ctx = this.ctx ?? new Ctor()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.7
    const gain = ctx.createGain()
    gain.gain.value = 1
    // graph: source -> analyser -> gain -> destination
    analyser.connect(gain)
    gain.connect(ctx.destination)
    this.ctx = ctx
    this.analyserNode = analyser
    this.gain = gain
    this.rmsBuf = new Uint8Array(new ArrayBuffer(analyser.fftSize))
    return ctx
  }

  /**
   * Resume the AudioContext. Must be called from a user gesture (e.g. mic click)
   * so browsers permit playback. Safe to call repeatedly. Returns a promise that
   * settles when the context is running (callers may ignore it).
   */
  resume(): Promise<void> {
    const ctx = this.ensureContext()
    return ctx.state === "suspended" ? ctx.resume() : Promise.resolve()
  }

  /** Resume a suspended context, awaiting it — used inside the schedule chain. */
  private async ensureResumed(): Promise<void> {
    const ctx = this.ctx
    if (ctx && ctx.state === "suspended") {
      try {
        await ctx.resume()
      } catch {
        /* a failed resume must not stall the chain — scheduling will no-op safely */
      }
    }
  }

  /**
   * Enqueue a base64-encoded audio chunk. Each chunk is a standalone WAV and is
   * played in ARRIVAL ORDER (the `seq` arg is not used to gate — see the file
   * header). `last` marks the final frame of a turn; the FIRST frame after a
   * `last` re-arms a fresh playback run so subsequent turns are never stuck
   * behind the previous turn's drained/suspended state. Decode+schedule is
   * serialized so timing stays correct.
   */
  enqueue(_seq: number, _mime: string, dataBase64: string, last = false): void {
    this.ensureContext()
    let data: ArrayBuffer
    try {
      data = base64ToArrayBuffer(dataBase64)
    } catch {
      if (last) this.ended = true // still close the turn so the next frame re-arms
      return // bad base64 — skip
    }
    this.accept(data, last)
  }

  /**
   * Enqueue a raw WAV ArrayBuffer (no base64) — the chat read-aloud's streamed
   * per-sentence frames arrive as binary, so this skips the base64 round-trip.
   */
  enqueueBuffer(data: ArrayBuffer, last = false): void {
    this.ensureContext()
    this.accept(data, last)
  }

  /** Shared decode+schedule entry for both base64 and binary enqueues. */
  private accept(data: ArrayBuffer, last: boolean): void {
    // A frame after a completed turn (`last:true`) is the next turn's first
    // frame: re-arm so the playhead re-anchors and a suspended context resumes.
    if (this.ended) {
      this.ended = false
      this.started = false
      this.startNotified = false
    }

    this._playing = true
    if (last) this.ended = true

    this.inFlight++
    // Resume BEFORE scheduling (awaited): a browser may have auto-suspended the
    // context after the previous turn drained; a fire-and-forget resume would let
    // source.start() race a still-suspended clock and the turn plays silently
    // until the next user gesture. Anchoring the playhead is deferred to the
    // schedule step so it reads a live (resumed) currentTime, not a frozen one.
    this.chain = this.chain
      .then(() => this.ensureResumed())
      .then(() => this.decodeAndSchedule(data))
  }

  /** Register a callback fired once when the first buffer of a run starts playing. */
  onStart(cb: () => void): void {
    this.startCb = cb
  }

  private async decodeAndSchedule(data: ArrayBuffer): Promise<void> {
    const ctx = this.ctx
    const analyser = this.analyserNode
    if (!ctx || !analyser) {
      this.inFlight = Math.max(0, this.inFlight - 1)
      return
    }

    let buffer: AudioBuffer
    try {
      // decodeAudioData consumes the ArrayBuffer; slice keeps callers safe.
      buffer = await ctx.decodeAudioData(data.slice(0))
    } catch {
      // Corrupt/unsupported chunk — skip it; the queue keeps flowing.
      this.inFlight = Math.max(0, this.inFlight - 1)
      this.checkIdle()
      return
    }

    // Anchor the playhead on the first scheduled frame of a run, AFTER the
    // context has resumed (currentTime is frozen while a context is suspended).
    if (!this.started) {
      this.started = true
      this.playhead = ctx.currentTime
    }

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(analyser)

    // Schedule back-to-back. If we've fallen behind (playhead in the past),
    // catch up to "now" to avoid scheduling in the past.
    const now = ctx.currentTime
    const startAt = Math.max(this.playhead, now)
    this.playhead = startAt + buffer.duration

    this.activeSources++
    this.inFlight = Math.max(0, this.inFlight - 1)
    this.liveSources.add(source)
    source.onended = () => {
      this.liveSources.delete(source)
      this.activeSources--
      this.checkIdle()
    }
    source.start(startAt)
    if (!this.startNotified) {
      this.startNotified = true
      this.startCb?.()
    }
  }

  private checkIdle(): void {
    // Idle only when nothing is playing AND nothing is still queued to decode.
    if (this.activeSources <= 0 && this.inFlight <= 0) {
      this._playing = false
      this.started = false
      const cb = this.idleCb
      if (cb) cb()
    }
  }

  /** The AnalyserNode the page reads for the speaking-state orb level. */
  get analyser(): AnalyserNode | null {
    return this.analyserNode
  }

  /** True while audio is queued or playing. */
  get playing(): boolean {
    return this._playing
  }

  /** Current output amplitude 0..1 (RMS from the analyser), or 0 when silent. */
  get level(): number {
    const analyser = this.analyserNode
    const buf = this.rmsBuf
    if (!analyser || !buf || !this._playing) return 0
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / buf.length)
    return Math.min(1, rms * 3.2)
  }

  /** Register a callback fired each time the queue fully drains. */
  onIdle(cb: () => void): void {
    this.idleCb = cb
  }

  /**
   * Drop all queued audio and reset ordering state (e.g. on cancel / unmount /
   * read-aloud pause). Halts any source that's already scheduled or playing —
   * not just future enqueues — so pause/stop is immediate and silent.
   */
  reset(): void {
    this.stopLiveSources()
    // Abandon the in-flight decode chain; future enqueues start a fresh chain.
    this.chain = Promise.resolve()
    this.started = false
    this.startNotified = false
    this.inFlight = 0
    this._playing = false
    this.activeSources = 0
    this.ended = false
    if (this.ctx) this.playhead = this.ctx.currentTime
  }

  /**
   * Immediately stop every scheduled/playing source. We null `onended` first so
   * the stop()-triggered callback doesn't run the activeSources/idle bookkeeping
   * (we've already zeroed it in reset), then `stop()` + `disconnect()` each one.
   */
  private stopLiveSources(): void {
    for (const source of this.liveSources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        /* not yet started, or already stopped — fine */
      }
      try {
        source.disconnect()
      } catch {
        /* best effort */
      }
    }
    this.liveSources.clear()
  }

  /** Fully tear down the AudioContext. Call on unmount. */
  dispose(): void {
    this.reset()
    this.idleCb = null
    this.startCb = null
    const ctx = this.ctx
    const owns = this.ownsCtx
    this.ctx = null
    this.analyserNode = null
    this.gain = null
    this.rmsBuf = null
    // Only close a context we created — a shared/external one belongs to the caller.
    if (owns && ctx && ctx.state !== "closed") void ctx.close().catch(() => {})
  }
}
