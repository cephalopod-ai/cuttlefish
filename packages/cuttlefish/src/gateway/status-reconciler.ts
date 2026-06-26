import type { Engine } from "../shared/types.js";
import { listSessions, updateSession } from "../sessions/registry.js";
import { notifyParentSession } from "../sessions/callbacks.js";
import type { SessionNotificationSink } from "../sessions/notification-sink.js";
import { logger } from "../shared/logger.js";

const DEFAULT_INTERVAL_MS = 15_000;
/** runWebSession's heartbeat refreshes lastActivity every 5s while a turn is in
 *  flight. A "running" session whose heartbeat is older than this has no live
 *  turn driving it — the completion event was lost.
 *
 *  Queued-but-not-started turns are safe: the POST handler sets
 *  status:"running" + lastActivity synchronously at enqueue, and runWebSession
 *  re-sets both when the queued turn actually starts (and the 5s heartbeat
 *  takes over). Worst case a long-delayed queue item gets its spinner cleared
 *  here and re-armed by session:started when the turn begins. */
export const DEFAULT_STALE_MS = 45_000;

export interface StatusReconcilerDeps {
  engines: Map<string, Engine>;
  emit: (event: string, payload: unknown) => void;
  intervalMs?: number;
  staleMs?: number;
  onAfterSweep?: () => void;
  notificationSink?: SessionNotificationSink;
  /** Test override. */
  now?: () => number;
  /** Carry-over between sweeps: sessions seen stuck once. A session is only
   *  reset on the SECOND consecutive sweep that finds it stuck — a single
   *  observation can be the benign seconds between a turn's process exiting
   *  and the gateway persisting its final status. Created by
   *  startStatusReconciler; tests may pass their own. */
  pendingStuck?: Set<string>;
}

export function sessionHasLiveTurn(
  session: Pick<import("../shared/types.js").Session, "id" | "engine">,
  engines: Map<string, Engine>,
): boolean {
  const engine = engines.get(session.engine);
  return !!engine && (
    "isTurnRunning" in engine
      ? (engine as unknown as { isTurnRunning(id: string): boolean }).isTurnRunning(session.id)
      : (typeof (engine as { isAlive?: (id: string) => boolean }).isAlive === "function"
        ? (engine as unknown as { isAlive(id: string): boolean }).isAlive(session.id)
        : false)
  );
}

/** One sweep: unstick sessions stuck at status:"running" with no live turn.
 *  Returns the number of sessions fixed. Exported for tests. */
export function sweepOnce(deps: StatusReconcilerDeps): number {
  const now = deps.now?.() ?? Date.now();
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  let fixed = 0;
  for (const session of listSessions({ status: "running" })) {
    const last = session.lastActivity ? new Date(session.lastActivity).getTime() : 0;
    const staleFor = now - last;
    if (staleFor < staleMs) {
      deps.pendingStuck?.delete(session.id); // fresh heartbeat — recovered, clear any mark
      continue; // heartbeat is live — a turn is in flight
    }
    // Same live-turn probe as the API status path: interactive engines expose
    // isTurnRunning (warm-but-idle PTYs must not count); headless engines
    // approximate with isAlive; an unknown engine cannot have a live turn.
    const turnRunning = sessionHasLiveTurn(session, deps.engines);
    if (turnRunning) {
      deps.pendingStuck?.delete(session.id); // live turn — clear any mark
      continue;
    }
    // Session qualifies as stuck: stale heartbeat + no live turn.
    const pending = deps.pendingStuck;
    if (pending && !pending.has(session.id)) {
      pending.add(session.id);
      continue; // confirm on the next sweep — could be a turn-boundary race
    }
    pending?.delete(session.id);
    // Don't erase the evidence. A session stuck at running with no live turn did
    // NOT complete cleanly — it stalled. Record an actionable error (instead of
    // nulling lastError), surface it on the completion event, and WAKE THE PARENT.
    // Without the parent wake, a delegated worker that stalls is silently dropped
    // to idle and the orchestrating director never learns its slice died — the
    // failure mode that previously required a human to notice. Status stays idle
    // so the spinner clears and the session can be re-driven.
    const stallError =
      `Stalled: session was stuck at status=running with no live turn ` +
      `(heartbeat stale ${Math.round(staleFor / 1000)}s) — auto-reset by the reconciler.`;
    updateSession(session.id, {
      status: "idle",
      lastActivity: new Date(now).toISOString(),
      lastError: stallError,
    });
    deps.emit("session:completed", {
      sessionId: session.id,
      employee: session.employee ?? undefined,
      title: session.title,
      result: null,
      error: stallError,
      stalled: true,
    });
    // Fire-and-forget wake to the delegating parent (no-op for top-level sessions
    // with no parentSessionId). This is the link that was missing: detection
    // existed, but its signal never reached the director.
    notifyParentSession(session, { error: stallError }, { sink: deps.notificationSink });
    logger.warn(
      `[reconciler] session ${session.id} (${session.engine}) was stuck status=running with no live turn ` +
      `(heartbeat stale ${Math.round(staleFor / 1000)}s) — reset to idle, parent notified`,
    );
    fixed++;
  }
  return fixed;
}

/** Start the periodic sweep. Returns a stop function. */
export function startStatusReconciler(deps: StatusReconcilerDeps): () => void {
  const pendingStuck = deps.pendingStuck ?? new Set<string>();
  const timer = setInterval(() => {
    try {
      sweepOnce({ ...deps, pendingStuck });
    } catch (err) {
      logger.warn(`[reconciler] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      deps.onAfterSweep?.();
    } catch (err) {
      logger.warn(`[reconciler] post-sweep callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
