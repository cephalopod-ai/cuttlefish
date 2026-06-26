import type { UpstreamActivityInfo } from "./sse-pty-proxy.js";

export const BACKGROUND_CLEAR_QUIET_MS = 10_000;

/** Tracks post-settle upstream activity reported by a PTY's SSE proxy. */
export class ClaudeBackgroundActivity {
  private states = new Map<string, { info: UpstreamActivityInfo; clearTimer?: NodeJS.Timeout; emitted: boolean }>();
  private cb?: (cuttlefishSessionId: string, info: UpstreamActivityInfo | null) => void;
  quietMs = BACKGROUND_CLEAR_QUIET_MS;

  constructor(private isTurnActive: (cuttlefishSessionId: string) => boolean) {}

  onBackgroundActivity(cb: (cuttlefishSessionId: string, info: UpstreamActivityInfo | null) => void): void {
    this.cb = cb;
  }

  /** Per-PTY SSE proxy reported an in-flight change. Always record it (counts
   *  must stay truthful across the run boundary); emission is gated downstream. */
  handleUpstreamActivity(cuttlefishSessionId: string, info: UpstreamActivityInfo): void {
    let st = this.states.get(cuttlefishSessionId);
    if (!st) {
      st = { info, emitted: false };
      this.states.set(cuttlefishSessionId, st);
    } else {
      st.info = info;
    }
    this.maybeEmit(cuttlefishSessionId);
  }

  /** Emit the session's background state if it's post-settle and changed:
   *  active streams emit immediately (cancelling any pending clear); zero
   *  streams arm a quiet-window timer that emits `null` once, only if activity
   *  was previously reported. Suppressed entirely while a run() is in flight. */
  maybeEmit(cuttlefishSessionId: string): void {
    const st = this.states.get(cuttlefishSessionId);
    if (!st) return;
    if (this.isTurnActive(cuttlefishSessionId)) return;
    if (st.info.activeStreams > 0) {
      if (st.clearTimer) { clearTimeout(st.clearTimer); st.clearTimer = undefined; }
      st.emitted = true;
      this.cb?.(cuttlefishSessionId, { ...st.info });
      return;
    }
    if (!st.emitted) {
      // Reached 0 without ever being reported post-settle — nothing to clear.
      this.states.delete(cuttlefishSessionId);
      return;
    }
    if (st.clearTimer) return; // quiet window already armed
    st.clearTimer = setTimeout(() => {
      const cur = this.states.get(cuttlefishSessionId);
      if (cur !== st) return; // state was recreated/cleared since arming
      if (cur.info.activeStreams > 0) { cur.clearTimer = undefined; return; }
      this.states.delete(cuttlefishSessionId);
      this.cb?.(cuttlefishSessionId, null);
    }, this.quietMs);
    st.clearTimer.unref?.();
  }

  /** A new run() is taking the session: retract any reported background state
   *  (the session is about to be "running") but KEEP the live counts — the proxy
   *  persists across turns, and run()'s finally re-checks them post-settle. */
  suppress(cuttlefishSessionId: string): void {
    const st = this.states.get(cuttlefishSessionId);
    if (!st) return;
    if (st.clearTimer) { clearTimeout(st.clearTimer); st.clearTimer = undefined; }
    const wasEmitted = st.emitted;
    st.emitted = false;
    if (wasEmitted) this.cb?.(cuttlefishSessionId, null);
  }

  /** Drop all background state for a session (PTY released / killed), emitting
   *  the cleared notification if activity had been reported. */
  clear(cuttlefishSessionId: string): void {
    const st = this.states.get(cuttlefishSessionId);
    if (!st) return;
    if (st.clearTimer) clearTimeout(st.clearTimer);
    this.states.delete(cuttlefishSessionId);
    if (st.emitted) this.cb?.(cuttlefishSessionId, null);
  }

  hasActive(cuttlefishSessionId: string): boolean {
    return (this.states.get(cuttlefishSessionId)?.info.activeStreams ?? 0) > 0;
  }
}
