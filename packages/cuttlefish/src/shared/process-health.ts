/**
 * Process-health signals for honest operator reporting (audit E1, E7, H1).
 *
 * The gateway deliberately keeps the daemon alive after an uncaught exception so
 * a single fault does not take down the whole org, and it drops connector
 * notifications when no transport is configured. Both were previously INVISIBLE —
 * the health endpoint stayed green in an undefined post-exception state, and a
 * dropped operator alert left no trace. This module records those events so
 * `/api/status` (and any readiness probe) can surface a degraded/unstable state
 * instead of reporting a false healthy.
 */

export interface ProcessHealthSnapshot {
  uncaughtExceptions: number;
  unhandledRejections: number;
  lastUncaughtAt: string | null;
  lastUncaughtMessage: string | null;
  droppedNotifications: number;
  lastDroppedNotificationAt: string | null;
  lastDroppedNotificationReason: string | null;
}

const state: ProcessHealthSnapshot = {
  uncaughtExceptions: 0,
  unhandledRejections: 0,
  lastUncaughtAt: null,
  lastUncaughtMessage: null,
  droppedNotifications: 0,
  lastDroppedNotificationAt: null,
  lastDroppedNotificationReason: null,
};

export function recordUncaughtException(err: unknown): void {
  state.uncaughtExceptions += 1;
  state.lastUncaughtAt = new Date().toISOString();
  state.lastUncaughtMessage = err instanceof Error ? err.message : String(err);
}

export function recordUnhandledRejection(): void {
  state.unhandledRejections += 1;
}

export function recordDroppedNotification(reason: string): void {
  state.droppedNotifications += 1;
  state.lastDroppedNotificationAt = new Date().toISOString();
  state.lastDroppedNotificationReason = reason;
}

export function getProcessHealth(): ProcessHealthSnapshot {
  return { ...state };
}

/**
 * True once the process has taken an uncaught exception: Node's post-exception
 * state is undefined, so the daemon (though kept alive) should no longer report
 * a clean healthy status.
 */
export function isProcessStable(): boolean {
  return state.uncaughtExceptions === 0;
}

/** Test-only reset. */
export function resetProcessHealthForTest(): void {
  state.uncaughtExceptions = 0;
  state.unhandledRejections = 0;
  state.lastUncaughtAt = null;
  state.lastUncaughtMessage = null;
  state.droppedNotifications = 0;
  state.lastDroppedNotificationAt = null;
  state.lastDroppedNotificationReason = null;
}
