/**
 * Local conservative throttle for Purdue GenAI / Pi.
 *
 * Purdue GenAI advertises roughly 20 messages/minute, but users have observed
 * lower practical ceilings. Cuttlefish therefore gates Pi starts at 10 messages/minute
 * and spaces starts evenly (one every 6s) so concurrent agents cannot burst into
 * the provider limit and stall the whole org.
 *
 * This is intentionally local/deterministic. It does not claim to know the
 * account-wide server quota; it prevents this gateway from being the source of a
 * recoverability bottleneck.
 */

export const DEFAULT_PI_MESSAGES_PER_MINUTE = 10;
const WINDOW_MS = 60_000;

export interface PiThrottleDecision {
  limit: number;
  windowMs: number;
  waitedMs: number;
  startedAtMs: number;
  usedInWindow: number;
  nextAvailableAtMs: number;
  resetsAtMs?: number;
}

export interface PiThrottleSnapshot {
  limit: number;
  windowMs: number;
  usedInWindow: number;
  remainingInWindow: number;
  usedPercent: number;
  nextAvailableAtMs: number;
  resetsAtMs?: number;
}

const startsMs: number[] = [];
let lastStartMs: number | undefined;
let queue: Promise<unknown> = Promise.resolve();

function normalizeLimit(limit: unknown): number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.max(1, Math.floor(limit))
    : DEFAULT_PI_MESSAGES_PER_MINUTE;
}

function spacingMs(limit: number): number {
  return Math.ceil(WINDOW_MS / limit);
}

function prune(now: number): void {
  while (startsMs.length > 0 && now - startsMs[0] >= WINDOW_MS) startsMs.shift();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSerialized(opts: {
  messagesPerMinute?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<PiThrottleDecision> {
  const limit = normalizeLimit(opts.messagesPerMinute);
  const nowFn = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  let waitedMs = 0;

  for (;;) {
    const now = nowFn();
    prune(now);
    const byRollingWindow = startsMs.length >= limit ? startsMs[0] + WINDOW_MS : now;
    const byEvenSpacing = lastStartMs !== undefined ? lastStartMs + spacingMs(limit) : now;
    const nextAvailableAtMs = Math.max(byRollingWindow, byEvenSpacing);
    const waitMs = Math.max(0, nextAvailableAtMs - now);

    if (waitMs === 0) {
      const startedAtMs = nowFn();
      prune(startedAtMs);
      startsMs.push(startedAtMs);
      lastStartMs = startedAtMs;
      const nextByWindow = startsMs.length >= limit ? startsMs[0] + WINDOW_MS : startedAtMs;
      const nextBySpacing = lastStartMs + spacingMs(limit);
      return {
        limit,
        windowMs: WINDOW_MS,
        waitedMs,
        startedAtMs,
        usedInWindow: startsMs.length,
        nextAvailableAtMs: Math.max(nextByWindow, nextBySpacing),
        resetsAtMs: startsMs.length > 0 ? startsMs[0] + WINDOW_MS : undefined,
      };
    }

    waitedMs += waitMs;
    await sleep(waitMs);
  }
}

/** Acquire one Pi message slot. Calls are serialized across the gateway process. */
export function acquirePiMessageSlot(opts: {
  messagesPerMinute?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<PiThrottleDecision> {
  const run = queue.then(() => acquireSerialized(opts), () => acquireSerialized(opts));
  queue = run.then(() => undefined, () => undefined);
  return run;
}

/** Snapshot the local Pi throttle for /limits and usage planning. */
export function getPiThrottleSnapshot(opts: {
  messagesPerMinute?: number;
  now?: number;
} = {}): PiThrottleSnapshot {
  const limit = normalizeLimit(opts.messagesPerMinute);
  const now = opts.now ?? Date.now();
  prune(now);
  const byRollingWindow = startsMs.length >= limit ? startsMs[0] + WINDOW_MS : now;
  const byEvenSpacing = lastStartMs !== undefined ? lastStartMs + spacingMs(limit) : now;
  const used = Math.min(startsMs.length, limit);
  return {
    limit,
    windowMs: WINDOW_MS,
    usedInWindow: used,
    remainingInWindow: Math.max(0, limit - used),
    usedPercent: (used / limit) * 100,
    nextAvailableAtMs: Math.max(byRollingWindow, byEvenSpacing),
    resetsAtMs: startsMs.length > 0 ? startsMs[0] + WINDOW_MS : undefined,
  };
}

/** Test-only reset hook. Exported but intentionally obscure. */
export function __resetPiThrottleForTests(): void {
  startsMs.length = 0;
  lastStartMs = undefined;
  queue = Promise.resolve();
}
