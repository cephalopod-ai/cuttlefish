/**
 * Small in-process async coordination primitives.
 *
 * Cuttlefish runs as a single Node daemon process (not distributed), so a
 * lightweight promise-chaining mutex/semaphore is enough to close the
 * read-modify-write and unbounded-fan-out races found across the gateway
 * (org-change apply, board JSON writes, ticket dispatch, concurrent run
 * dispatch). No external lock/mutex library is used anywhere else in this
 * repo — `KeyedMutex` generalizes the same per-key promise-chaining pattern
 * `sessions/queue.ts`'s `SessionQueue.enqueue` already uses.
 */

import { logger } from "./logger.js";

/** Serializes async work per string key. A key with no in-flight work has no footprint. */
export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();
  private locked = new Set<string>();

  /** Runs `fn` once all previously-queued work for `key` has settled, releasing even if `fn` throws. */
  async withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    this.locked.add(key);
    const run = async () => {
      try {
        return await fn();
      } finally {
        // Only clear the "locked" flag once we're the last queued waiter —
        // a later withLock() call may already have re-added itself to `chains`.
        if (this.chains.get(key) === next) {
          this.chains.delete(key);
          this.locked.delete(key);
        }
      }
    };
    const next = prev.then(run, run);
    this.chains.set(key, next);
    return next as Promise<T>;
  }

  /** Synchronous peek for callers that can't await (e.g. a synchronous write guard). */
  isLocked(key: string): boolean {
    return this.locked.has(key);
  }
}

export type Release = () => void;

/** Thrown by `Semaphore.acquire()` when `options.timeoutMs` elapses before a permit frees up. */
export class SemaphoreAcquireTimeoutError extends Error {
  constructor(public readonly waitedMs: number) {
    super(`Semaphore.acquire() timed out after ${waitedMs}ms waiting for a permit`);
    this.name = "SemaphoreAcquireTimeoutError";
  }
}

export interface AcquireOptions {
  /** Reject with SemaphoreAcquireTimeoutError if no permit frees up within this many ms. Unset = wait forever (default, existing behavior). */
  timeoutMs?: number;
  /** Log a one-time warn if the wait exceeds this many ms, even when timeoutMs is unset — for operator visibility into stuck callers. */
  warnAfterMs?: number;
}

/** Bounds concurrent work to `limit` in-flight callers at a time. */
export class Semaphore {
  private inFlight = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly defaultLimit: number) {}

  /** Non-blocking: returns a release function on success, or null if the limit is already reached. */
  tryAcquire(limit = this.defaultLimit): Release | null {
    if (this.inFlight >= Math.max(1, limit)) return null;
    this.inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  /**
   * Blocking: resolves once a permit is available (FIFO).
   *
   * With no `options` (or no `timeoutMs`), this preserves the original
   * unbounded-wait behavior and never rejects. Pass `options.timeoutMs` to
   * bound the wait — the queued waiter is removed and the permit is left
   * untouched for the next caller if the timeout fires first.
   */
  async acquire(limit = this.defaultLimit, options?: AcquireOptions): Promise<Release> {
    const immediate = this.tryAcquire(limit);
    if (immediate) return immediate;

    const { timeoutMs, warnAfterMs } = options ?? {};
    const startedAt = Date.now();

    await new Promise<void>((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | undefined;
      let warnHandle: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (warnHandle) clearTimeout(warnHandle);
      };
      const waiter = () => {
        cleanup();
        resolve();
      };
      this.waiters.push(waiter);

      if (warnAfterMs !== undefined && warnAfterMs > 0 && (timeoutMs === undefined || warnAfterMs < timeoutMs)) {
        warnHandle = setTimeout(() => {
          logger.warn(
            `Semaphore.acquire() has been waiting ${Date.now() - startedAt}ms for a permit (inFlight=${this.inFlight}, waiters=${this.waiters.length})`
          );
        }, warnAfterMs);
      }

      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          cleanup();
          reject(new SemaphoreAcquireTimeoutError(Date.now() - startedAt));
        }, timeoutMs);
      }
    });
    // release() hands the permit directly to us without ever decrementing
    // inFlight, so there is no window where another caller could steal it —
    // no re-increment needed here.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  async withPermit<T>(fn: () => T | Promise<T>, limit = this.defaultLimit): Promise<T> {
    const release = await this.acquire(limit);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the permit straight to the next waiter — inFlight stays as-is
      // (still "held", now by the waiter) so no other caller can slip in
      // between the free and the re-acquire.
      next();
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}
