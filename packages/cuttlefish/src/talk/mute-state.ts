/**
 * Cuttlefish Talk — per-session mute state (server side).
 *
 * The /talk client can run in silent/read mode (the operator muted AURA). When
 * it does, the browser discards any streamed Kokoro audio — but the gateway was
 * still synthesizing the whole turn server-side and throwing it away, burning a
 * neural-TTS call and adding latency for nothing. This tiny in-memory registry
 * lets the client tell the gateway "this talk session is muted" (POST
 * /api/talk/mute) so the run loop can SKIP synthesis entirely while muted.
 *
 * In-memory + best-effort by design: it mirrors a transient client UI toggle, so
 * a gateway restart (state lost → treated as not-muted) just resumes speaking,
 * which is the safe default. No persistence needed.
 */
const mutedSessions = new Set<string>();

/** Mark (or unmark) a talk session as muted. No-op for an empty id. */
export function setTalkMuted(sessionId: string, muted: boolean): void {
  if (!sessionId) return;
  if (muted) mutedSessions.add(sessionId);
  else mutedSessions.delete(sessionId);
}

/** True when the talk session is currently muted (unknown → false). */
export function isTalkMuted(sessionId: string): boolean {
  return mutedSessions.has(sessionId);
}

/** Forget a session entirely (e.g. on session delete). */
export function clearTalkMuted(sessionId: string): void {
  mutedSessions.delete(sessionId);
}
