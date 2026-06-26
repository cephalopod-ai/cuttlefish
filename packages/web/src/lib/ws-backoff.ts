/** First reconnect attempt waits roughly this long. */
export const WS_RECONNECT_BASE_MS = 1000;
/** Hard ceiling on any single reconnect delay. */
export const WS_RECONNECT_MAX_MS = 30_000;

/**
 * Exponential backoff with "equal jitter", capped at {@link WS_RECONNECT_MAX_MS}.
 *
 * The uncapped window for `attempt` is `base * 2^attempt`. We take half of that
 * window as a fixed floor and add a random amount across the other half, so the
 * delay lands in `[window/2, window]`. The jitter decorrelates a fleet of
 * clients all reconnecting after the same gateway restart (no thundering herd),
 * while the floor guarantees the delay still grows with each attempt instead of
 * occasionally collapsing to ~0 (which full jitter allows).
 *
 * @param attempt 0-based retry counter (negative is treated as 0).
 * @param rng injectable randomness in [0,1) for deterministic tests.
 */
export function nextReconnectDelay(
  attempt: number,
  rng: () => number = Math.random,
  opts?: { baseMs?: number; maxMs?: number },
): number {
  const baseMs = opts?.baseMs ?? WS_RECONNECT_BASE_MS;
  const maxMs = opts?.maxMs ?? WS_RECONNECT_MAX_MS;
  const safeAttempt = Math.max(0, Math.floor(attempt));
  // 2^safeAttempt can overflow for absurd attempt counts; clamp before scaling.
  const window = Math.min(maxMs, baseMs * 2 ** Math.min(safeAttempt, 31));
  const half = window / 2;
  return Math.round(half + rng() * half);
}
