export interface HookPayload {
  hook_event_name: "SessionStart" | "Stop" | "StopFailure" | "PreToolUse" | "PostToolUse" | string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  last_assistant_message?: string;
  tool_name?: string;
  /** Present on StopFailure: enum — rate_limit | authentication_failed | billing_error | invalid_request | server_error | max_output_tokens | unknown */
  error?: string;
  error_details?: string;
  [k: string]: unknown;
}

type HookListener = (h: HookPayload) => void;
type UnclaimedHookHandler = (cuttlefishSessionId: string, h: HookPayload) => void;
interface Buffered { payload: HookPayload; at: number; }

export class HookRegistry {
  private listeners = new Map<string, HookListener>();
  private buffer = new Map<string, Buffered[]>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Fallback consumer for Stop hooks no turn ever claims (PTY-native turns
   *  typed straight into the xterm view, or a Stop arriving past the late-
   *  recovery window). Set once by the gateway. */
  private unclaimedHandler: UnclaimedHookHandler | undefined;
  /** Per-session debounce timers for the unclaimed-Stop fallback. */
  private unclaimedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private ttlMs = 30_000, sweepIntervalMs = 5_000, private unclaimedDelayMs = 2_000) {
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    // Don't keep the event loop alive for the sweep timer.
    this.sweepTimer.unref?.();
  }

  /** Install the fallback consumer for unclaimed Stop hooks. A Stop that lands
   *  with no registered listener is buffered as usual AND starts/refreshes a
   *  short timer; if the session is still unclaimed when it fires, the handler
   *  receives the Stop (and the consumed Stops leave the buffer so a later
   *  register() can't replay them into a NEW turn's resolver). */
  setUnclaimedHookHandler(handler: UnclaimedHookHandler): void {
    this.unclaimedHandler = handler;
  }

  register(cuttlefishSessionId: string, listener: HookListener): void {
    if (this.listeners.has(cuttlefishSessionId)) {
      // Engine guards against concurrent turns per session, so this should
      // never happen. Warn loudly if it does — silently overwriting the
      // previous listener would mean the prior turn's resolver never fires.
      console.warn(
        `[HookRegistry] duplicate listener registration for session ${cuttlefishSessionId}; previous listener will be replaced`,
      );
    }
    this.listeners.set(cuttlefishSessionId, listener);
    // A turn claimed the session — the buffered events are its, not the
    // unclaimed-fallback's.
    this.cancelUnclaimedTimer(cuttlefishSessionId);
    const pending = this.buffer.get(cuttlefishSessionId);
    if (pending) {
      this.buffer.delete(cuttlefishSessionId);
      const now = Date.now();
      for (const b of pending) {
        if (now - b.at <= this.ttlMs) listener(b.payload);
      }
    }
  }

  unregister(cuttlefishSessionId: string): void {
    this.listeners.delete(cuttlefishSessionId);
    this.buffer.delete(cuttlefishSessionId);
  }

  deliver(cuttlefishSessionId: string, payload: HookPayload): void {
    const listener = this.listeners.get(cuttlefishSessionId);
    if (listener) { listener(payload); return; }
    const arr = this.buffer.get(cuttlefishSessionId) ?? [];
    arr.push({ payload, at: Date.now() });
    this.buffer.set(cuttlefishSessionId, arr);
    // Unclaimed Stop with real output → arm/refresh the fallback timer. The
    // delay protects the registration race at turn start: an in-flight run()
    // registers its listener BEFORE the prompt is even written to the PTY
    // (claude-interactive.ts run(): register → inject/spawn), so a Stop
    // belonging to a gateway-run turn can never sit unclaimed for long — by the
    // time the timer fires, "still unclaimed" means no run() owns this session
    // (a PTY-native turn) or the Stop arrived past the late-recovery window.
    if (
      this.unclaimedHandler &&
      payload.hook_event_name === "Stop" &&
      String(payload.last_assistant_message ?? "").trim()
    ) {
      this.armUnclaimedTimer(cuttlefishSessionId);
    }
  }

  private armUnclaimedTimer(cuttlefishSessionId: string): void {
    this.cancelUnclaimedTimer(cuttlefishSessionId);
    const timer = setTimeout(() => this.fireUnclaimed(cuttlefishSessionId), this.unclaimedDelayMs);
    timer.unref?.();
    this.unclaimedTimers.set(cuttlefishSessionId, timer);
  }

  private cancelUnclaimedTimer(cuttlefishSessionId: string): void {
    const t = this.unclaimedTimers.get(cuttlefishSessionId);
    if (t) {
      clearTimeout(t);
      this.unclaimedTimers.delete(cuttlefishSessionId);
    }
  }

  /** Timer expired with the session still unclaimed: hand the buffered Stop(s)
   *  to the fallback handler. Consumed Stops are REMOVED from the buffer so a
   *  later register() can't drain a stale Stop into a fresh turn's resolver.
   *  Only the newest Stop is delivered — the handler syncs the transcript tail
   *  from an anchor, so intermediate Stops are covered by the same sync. */
  private fireUnclaimed(cuttlefishSessionId: string): void {
    this.unclaimedTimers.delete(cuttlefishSessionId);
    if (!this.unclaimedHandler) return;
    if (this.listeners.has(cuttlefishSessionId)) return; // claimed in the meantime
    const arr = this.buffer.get(cuttlefishSessionId);
    if (!arr || arr.length === 0) return;
    const isConsumable = (b: Buffered) =>
      b.payload.hook_event_name === "Stop" && String(b.payload.last_assistant_message ?? "").trim() !== "";
    const stops = arr.filter(isConsumable);
    if (stops.length === 0) return;
    const rest = arr.filter((b) => !isConsumable(b));
    if (rest.length === 0) this.buffer.delete(cuttlefishSessionId);
    else this.buffer.set(cuttlefishSessionId, rest);
    try {
      this.unclaimedHandler(cuttlefishSessionId, stops[stops.length - 1].payload);
    } catch (err) {
      console.warn(`[HookRegistry] unclaimed hook handler threw for ${cuttlefishSessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Drop buffered entries whose `at` is older than ttlMs. */
  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [sid, arr] of this.buffer) {
      const fresh = arr.filter((b) => b.at >= cutoff);
      if (fresh.length === 0) this.buffer.delete(sid);
      else if (fresh.length !== arr.length) this.buffer.set(sid, fresh);
    }
  }

  /** Stop the periodic sweep timer. Call when shutting down the registry. */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const t of this.unclaimedTimers.values()) clearTimeout(t);
    this.unclaimedTimers.clear();
  }
}
