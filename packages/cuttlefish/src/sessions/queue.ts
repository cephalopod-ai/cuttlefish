import {
  getQueueItem,
  listPausedQueueKeys,
  markQueueItemCompleted,
  markQueueItemRunning,
  pauseQueueKey,
  resumeQueueKey,
} from "./registry.js";

/** Thrown when a queued task waits longer than the pause cap for its session key
 *  to be resumed (audit E6). Surfaces the strand instead of hanging forever. */
export class QueuePausedTimeoutError extends Error {
  constructor(sessionKey: string, waitedMs: number) {
    super(`Queued task for "${sessionKey}" abandoned: session key stayed paused for ${waitedMs}ms without resume`);
    this.name = "QueuePausedTimeoutError";
  }
}

const DEFAULT_PAUSE_MAX_WAIT_MS = 60 * 60 * 1000;

interface QueueGeneration {
  pending: number;
  cancelled: boolean;
}

export class SessionQueue {
  private queues = new Map<string, Promise<void>>();
  /** Max time a task will wait on a paused key before it is abandoned (bounded
   *  wait guardrail, audit E6). 0 disables the cap (legacy unbounded behavior). */
  private pauseMaxWaitMs: number;
  /** Track which sessions are currently running */
  private running = new Map<string, QueueGeneration>();
  /** Track how many tasks exist per session key, including the active one. */
  private generations = new Map<string, QueueGeneration>();
  /** Track which session keys have been cancelled - queued tasks are skipped. */
  private cancelled = new Set<string>();
  /** Track which session keys are paused - queued tasks wait until resumed. */
  private paused = new Set<string>();
  /** Resolvers for tasks blocked on a paused session key, woken on resume. */
  private pauseWaiters = new Map<string, Array<() => void>>();

  constructor(opts?: { pauseMaxWaitMs?: number }) {
    this.paused = new Set(listPausedQueueKeys());
    this.pauseMaxWaitMs = opts?.pauseMaxWaitMs ?? DEFAULT_PAUSE_MAX_WAIT_MS;
  }

  /**
   * Check if a session is currently running.
   */
  isRunning(sessionKey: string): boolean {
    return this.running.has(sessionKey);
  }

  hasScheduled(sessionKey: string): boolean {
    return this.running.has(sessionKey) || this.queues.has(sessionKey);
  }

  getPendingCount(sessionKey: string): number {
    const generation = this.generations.get(sessionKey);
    const total = generation?.pending ?? 0;
    return generation && this.running.get(sessionKey) === generation ? Math.max(0, total - 1) : total;
  }

  getTransportState(sessionKey: string, status?: "idle" | "running" | "error" | "waiting" | "interrupted"): "idle" | "queued" | "running" | "error" | "interrupted" {
    if (status === "error") return "error";
    if (status === "interrupted") return "interrupted";
    if (this.running.has(sessionKey)) return "running";
    if (this.getPendingCount(sessionKey) > 0) return "queued";
    return status === "running" ? "running" : "idle";
  }

  /**
   * Add a session key to the cancelled set and remove it from pending.
   * Any queued tasks for this key will be skipped when they next execute.
   */
  clearQueue(sessionKey: string): void {
    this.cancelled.add(sessionKey);
    const generation = this.generations.get(sessionKey);
    if (generation) generation.cancelled = true;
    this.generations.delete(sessionKey);
    // Cancelled paused tasks must drain without resuming newly accepted work.
    this.wakePausedTasks(sessionKey);
  }

  /**
   * Remove a session key from the cancelled set.
   * Call this before dispatching a new message so subsequent tasks run normally.
   */
  clearCancelled(sessionKey: string): void {
    this.cancelled.delete(sessionKey);
    if (this.generations.get(sessionKey)?.cancelled) this.generations.delete(sessionKey);
  }

  pauseQueue(sessionKey: string): void {
    this.paused.add(sessionKey);
    pauseQueueKey(sessionKey);
  }

  resumeQueue(sessionKey: string): void {
    this.paused.delete(sessionKey);
    resumeQueueKey(sessionKey);
    this.wakePausedTasks(sessionKey);
  }

  private wakePausedTasks(sessionKey: string): void {
    const waiters = this.pauseWaiters.get(sessionKey);
    if (waiters) {
      this.pauseWaiters.delete(sessionKey);
      for (const wake of waiters) wake();
    }
  }

  isPaused(sessionKey: string): boolean {
    return this.paused.has(sessionKey);
  }

  /**
   * Enqueue a task for a session. Tasks are serialized per session key.
   */
  async enqueue(sessionKey: string, fn: () => Promise<void>, queueItemId?: string): Promise<void> {
    let generation = this.generations.get(sessionKey);
    if (!generation) {
      generation = { pending: 0, cancelled: this.cancelled.has(sessionKey) };
      this.generations.set(sessionKey, generation);
    }
    // Each task retains its cancellation identity even when a new message clears
    // the key-wide cancellation flag and starts a fresh generation.
    const taskGeneration = generation;
    taskGeneration.pending += 1;
    const prev = this.queues.get(sessionKey) || Promise.resolve();
    const runTask = async () => {
      this.running.set(sessionKey, taskGeneration);
      let queueItemStarted = false;
      try {
        // Wait while paused — blocks until resumeQueue() wakes us (no polling).
        // Audit E6: bounded so a key paused-and-persisted but never resumed does
        // not strand this task forever (and leak its resolver for the process
        // lifetime). On expiry the task is abandoned with a clear, surfaced error.
        const waitStartedAt = Date.now();
        while (this.paused.has(sessionKey) && !taskGeneration.cancelled) {
          const remaining =
            this.pauseMaxWaitMs > 0 ? this.pauseMaxWaitMs - (Date.now() - waitStartedAt) : Infinity;
          if (remaining <= 0) {
            throw new QueuePausedTimeoutError(sessionKey, Date.now() - waitStartedAt);
          }
          await this.waitForResumeOrTimeout(sessionKey, remaining);
        }
        if (taskGeneration.cancelled) return;
        if (queueItemId) {
          const item = getQueueItem(queueItemId);
          if (!item || item.status !== "pending") return;
          if (!markQueueItemRunning(queueItemId)) return;
          queueItemStarted = true;
        }
        await fn();
      } finally {
        // Mark the DB row done in finally so an errored/cancelled task can't
        // leave the item stuck as 'running' (getQueueItems returns 'running'
        // rows, so a stuck row would keep the UI badge from draining).
        if (queueItemStarted && queueItemId) markQueueItemCompleted(queueItemId);
        if (this.running.get(sessionKey) === taskGeneration) this.running.delete(sessionKey);
        taskGeneration.pending = Math.max(0, taskGeneration.pending - 1);
      }
    };
    const next = prev.then(runTask, runTask);
    this.queues.set(sessionKey, next);
    // The returned `next` carries any task rejection to the caller. This internal
    // cleanup chain must swallow it so a rejected task (e.g. QueuePausedTimeoutError,
    // audit E6) does not surface as an unhandled rejection on the floating promise.
    void next
      .finally(() => {
        if (this.queues.get(sessionKey) === next) {
          this.queues.delete(sessionKey);
          if (this.generations.get(sessionKey) === taskGeneration) this.generations.delete(sessionKey);
        }
      })
      .catch(() => {});
    return next;
  }

  /** Wait until this key is resumed (resolver pushed to pauseWaiters) or the cap
   *  elapses. On timeout the resolver is removed so it is not leaked or double-woken. */
  private waitForResumeOrTimeout(sessionKey: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      const waiters = this.pauseWaiters.get(sessionKey) ?? [];
      waiters.push(wake);
      this.pauseWaiters.set(sessionKey, waiters);
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            const current = this.pauseWaiters.get(sessionKey);
            if (current) {
              const idx = current.indexOf(wake);
              if (idx !== -1) current.splice(idx, 1);
              if (current.length === 0) this.pauseWaiters.delete(sessionKey);
            }
            resolve(); // loop re-checks paused + remaining budget, then throws if expired
          }, timeoutMs)
        : undefined;
      timer?.unref?.();
    });
  }
}
