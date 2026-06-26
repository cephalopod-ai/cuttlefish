import type { EngineResult } from "./types.js";

const RATE_LIMIT_ERROR_RE =
  /rate.?limit|too many requests|429|overloaded|usage.*limit|exceeded.*limit|out of extra usage|insufficient.*credits|credits?.*exhaust/i;

export interface RateLimitDetection {
  limited: boolean;
  /** Unix timestamp in seconds */
  resetsAt?: number;
}

/** Patterns that indicate the engine session is dead (expired, not found, etc.) */
const DEAD_SESSION_PATTERNS = [
  /error.during.execution/i,
  /session.not.found/i,
  /invalid.session/i,
  /session.*expired/i,
];

/**
 * Detect whether an engine result indicates a dead/expired session rather than
 * a transient or rate-limit error. A dead session is one where the engine exited
 * with an error but did zero work (no cost, no turns) and there is no rate-limit
 * signal — meaning the --resume ID is stale and should not be retried.
 */
export function isDeadSessionError(result: EngineResult): boolean {
  if (!result.error) return false;

  // If rate limit info is present, this is a rate limit, not a dead session
  if (result.rateLimit?.status) return false;

  const zeroCost = result.cost === undefined || result.cost === 0;
  const zeroTurns = result.numTurns === undefined || result.numTurns === 0;

  // Primary: error with zero work done and no rate limit
  if (zeroCost && zeroTurns) return true;

  // Secondary: known dead-session patterns in error text, but only when no real
  // work was done (zeroCost) — avoids wiping IDs after a real session that
  // happened to include a matching substring in its error message.
  if (zeroCost && DEAD_SESSION_PATTERNS.some((p) => p.test(result.error!))) return true;

  return false;
}

export function detectRateLimit(result: EngineResult): RateLimitDetection {
  const resetsAt = typeof result.rateLimit?.resetsAt === "number"
    ? result.rateLimit.resetsAt
    : undefined;

  if (result.rateLimit?.status === "rejected") {
    // If Claude is actively using extra usage (overage billing), the request
    // went through — don't treat the rate limit event as a blocking rejection.
    if (result.rateLimit.isUsingOverage === true) {
      return { limited: false };
    }
    return { limited: true, resetsAt };
  }

  if (result.error && RATE_LIMIT_ERROR_RE.test(result.error)) {
    return { limited: true, resetsAt };
  }

  return { limited: false };
}

export function computeRateLimitDeadlineMs(resetsAtSeconds?: number, extraMs = 30 * 60_000): number {
  if (typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)) {
    return resetsAtSeconds * 1000 + extraMs;
  }
  return Date.now() + extraMs;
}

export function computeNextRetryDelayMs(resetsAtSeconds?: number): { delayMs: number; resumeAt?: Date } {
  if (typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)) {
    const resumeAt = new Date(resetsAtSeconds * 1000);
    // Add a small buffer to avoid retrying a few ms before the reset boundary.
    const bufferMs = 10_000;
    const delayMs = Math.max(10_000, resumeAt.getTime() - Date.now() + bufferMs);
    return { delayMs, resumeAt };
  }
  return { delayMs: 60_000 };
}
