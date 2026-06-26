/**
 * PTY lifecycle for the interactive Claude engine (CLI/xterm view).
 *
 * Rules:
 *   - A PTY stays alive while: a turn is running, OR at least one user is viewing
 *     the session, OR less than CLI_KEEPALIVE_AFTER_LEAVE_MS has elapsed since
 *     BOTH viewing ended AND the last turn ended (whichever happened later).
 *   - A 30s sweep enforces the grace cap once both conditions lapse.
 *   - maxLivePtys is an IDLE warm-PTY cap. Running turns and actively viewed
 *     terminals are never counted against it or killed to satisfy it.
 */

export const CLI_KEEPALIVE_AFTER_LEAVE_MS = 4 * 60 * 60 * 1000;

export interface PtyHandle {
  pid: number;
  killed: boolean;
  kill: (signal?: string) => void;
}

export interface PtyLifecycleOpts {
  maxLivePtys: number;
  /** Called after a new PTY session is adopted — used to refresh gateway.json pids. */
  onAdopt?: (sessionId: string) => void;
  /** Called after a PTY is killed/removed — used to clean the --settings file, hook registry, gateway.json pids. */
  onCleanup?: (sessionId: string) => void;
}

export interface PtyAdoptState {
  /** Set for cold spawns that are immediately serving a turn. */
  turnRunning?: boolean;
  /** Optional initial viewer count for a terminal-born PTY. */
  viewerCount?: number;
}

interface Entry {
  handle: PtyHandle;
  turnRunning: boolean;
  viewerCount: number;
  viewingEndedAt: number; // epoch ms; 0 while at least one viewer is attached
  lastTurnEndedAt: number; // epoch ms; 0 if no turn has completed yet
}

function shouldStayAlive(e: Entry, now: number): boolean {
  if (e.turnRunning) return true;
  if (e.viewerCount > 0) return true;
  const since = Math.max(e.viewingEndedAt, e.lastTurnEndedAt);
  if (since > 0 && now - since < CLI_KEEPALIVE_AFTER_LEAVE_MS) return true;
  return false;
}

export class PtyLifecycleManager {
  private entries = new Map<string, Entry>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private releaseListeners: Array<(sessionId: string) => void> = [];

  constructor(private opts: PtyLifecycleOpts) {
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    this.sweepTimer.unref();
  }

  adopt(sessionId: string, handle: PtyHandle, state: PtyAdoptState = {}): void {
    const turnRunning = state.turnRunning === true;
    const viewerCount = Math.max(0, state.viewerCount ?? 0);
    if (!turnRunning && viewerCount === 0 && this.idleWarmCount() >= this.opts.maxLivePtys) {
      this.evictLru();
    }
    this.entries.set(sessionId, {
      handle,
      turnRunning,
      viewerCount,
      viewingEndedAt: viewerCount > 0 ? 0 : Date.now(),
      lastTurnEndedAt: turnRunning ? 0 : Date.now(),
    });
    this.opts.onAdopt?.(sessionId);
  }

  getWarm(sessionId: string): PtyHandle | undefined {
    return this.entries.get(sessionId)?.handle;
  }

  isAtCapacity(): boolean {
    return this.idleWarmCount() >= this.opts.maxLivePtys;
  }

  livePids(): number[] {
    return [...this.entries.values()].map((e) => e.handle.pid);
  }

  viewerEnter(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.viewerCount += 1;
    e.viewingEndedAt = 0;
  }

  viewerLeave(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.viewerCount = Math.max(0, e.viewerCount - 1);
    if (e.viewerCount === 0) {
      e.viewingEndedAt = Date.now();
      this.reevaluate(sessionId);
    }
  }

  turnStarted(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (e) e.turnRunning = true;
  }

  turnEnded(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.turnRunning = false;
    e.lastTurnEndedAt = Date.now();
    this.reevaluate(sessionId);
  }

  /** Engine-side release hook: invoked for EVERY released session (manual release,
   *  LRU eviction, sweep reap, killAll), after the gateway's onCleanup. Engines use
   *  it to purge per-session bookkeeping (spawn params, output timestamps) so their
   *  maps don't grow forever in a long-running daemon. */
  onRelease(listener: (sessionId: string) => void): void {
    this.releaseListeners.push(listener);
  }

  releaseSession(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    this.entries.delete(sessionId);
    if (!e.handle.killed) {
      e.handle.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (!e.handle.killed) e.handle.kill("SIGKILL");
      }, 2000);
      forceKill.unref?.();
    }
    this.opts.onCleanup?.(sessionId);
    for (const l of this.releaseListeners) l(sessionId);
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.releaseSession(id);
  }

  /** Release only PTYs that are NOT serving an in-flight turn. Used by org-reload
   *  to recycle idle warm PTYs (so the next turn cold-respawns with the fresh
   *  persona) WITHOUT killing the PTY of a turn currently running — e.g. the turn
   *  that just wrote the org file which triggered the reload. A session is spared
   *  if its entry has `turnRunning` set OR the caller's `isActive` predicate flags
   *  it (covers the cold-spawn window where the engine's active set is populated
   *  before `turnStarted` mirrors it here). */
  releaseIdle(isActive: (sessionId: string) => boolean): void {
    for (const [id, e] of [...this.entries.entries()]) {
      if (e.turnRunning || isActive(id)) continue;
      this.releaseSession(id);
    }
  }

  private reevaluate(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    if (!shouldStayAlive(e, Date.now())) this.releaseSession(sessionId);
  }

  private sweep(): void {
    for (const id of [...this.entries.keys()]) this.reevaluate(id);
  }

  private idleWarmCount(): number {
    let count = 0;
    for (const e of this.entries.values()) {
      if (!e.turnRunning && e.viewerCount === 0) count++;
    }
    return count;
  }

  /** Idle warm-PTY eviction: pick the eligible entry (no viewer, no running turn)
   *  with the oldest max(viewingEndedAt, lastTurnEndedAt). If none are eligible, no-op. */
  private evictLru(): void {
    let victim: string | null = null;
    let oldest = Infinity;
    for (const [id, e] of this.entries.entries()) {
      if (e.turnRunning || e.viewerCount > 0) continue;
      const since = Math.max(e.viewingEndedAt, e.lastTurnEndedAt);
      if (since < oldest) {
        oldest = since;
        victim = id;
      }
    }
    if (victim) this.releaseSession(victim);
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.killAll();
  }
}
