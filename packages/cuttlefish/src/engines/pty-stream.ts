import type * as NodePty from "node-pty";
import { createRequire } from "node:module";
import { logger } from "../shared/logger.js";
import type { PtyControlEvent } from "./pty-view-engine.js";
import type { PtyHandle } from "./pty-lifecycle.js";

export type CuttlefishPty = NodePty.IPty;
type SpawnPtyOptions = Parameters<typeof NodePty.spawn>[2];

const require = createRequire(import.meta.url);
let ptyModule: typeof NodePty | null = null;

function loadPtyModule(): typeof NodePty {
  ptyModule ??= require("node-pty") as typeof NodePty;
  return ptyModule;
}

export function spawnPty(file: string, args: string[], options: SpawnPtyOptions): CuttlefishPty {
  try {
    const pty = loadPtyModule();
    return pty.spawn(file, args, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Interactive PTY support is unavailable: ${message}`);
  }
}

/** Cap for the per-session PTY scrollback ring buffer (xterm.js reconnect replay). */
export const SCROLLBACK_CAP_BYTES = 262144;

/** Cap for small per-session bookkeeping maps that must survive PTY respawns
 *  (e.g. last-known terminal geometry). Bounds growth in a long-running daemon. */
export const SESSION_MAP_CAP = 512;

/** Cap for the per-session stream-entry map. Each entry can hold up to
 *  SCROLLBACK_CAP_BYTES of scrollback, so this map gets its own (much smaller)
 *  cap: scrollback replay is only useful for the most recent sessions, and 128
 *  is far above maxLivePtys — live sessions are recently-touched (attach/
 *  subscribe refresh recency) and therefore never the eviction victim. */
export const STREAM_MAP_CAP = 128;

/** Set a value in an insertion-ordered per-session map, evicting the oldest-touched
 *  entries beyond `cap` so the map can't grow forever in a long-running daemon.
 *  Re-setting an existing key refreshes its recency (delete + re-insert). */
export function setCapped<V>(map: Map<string, V>, key: string, value: V, cap = SESSION_MAP_CAP): void {
  if (map.has(key)) map.delete(key); // re-insert so recently-touched keys are evicted last
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

interface Subscriber {
  data: (d: Buffer) => void;
  control?: (e: PtyControlEvent) => void;
}

interface StreamEntry {
  chunks: Buffer[];
  totalBytes: number;
  subscribers: Set<Subscriber>;
  /** Set to true the first time a PTY is wired to this stream entry. Subsequent
   *  wires (subscribers attached or not) are PTY respawns — clients need a reset
   *  so their xterm doesn't render the new alt-screen atop the old one's cells. */
  hasSeenPty: boolean;
}

/**
 * Per-session PTY output streams shared by the interactive engines (claude/codex/agy):
 * scrollback ring buffer (chunk list + running byte total) + live subscribers.
 * Survives PTY respawn. The chunk-list ring avoids the O(N) realloc that a
 * `(buffer + d).slice(-CAP)` per data event would cause at hot output.
 *
 * Engine-specific onExit handling (lifecycle identity-gating, turn interruption,
 * proxy teardown) stays in the engines — they call onPtyExit() from their own
 * onExit handlers when the dying PTY is the session's current one.
 */
export class PtyStreamManager {
  private streams = new Map<string, StreamEntry>();

  constructor(
    /** Log prefix for PTY socket errors (e.g. "PTY", "Codex PTY", "Antigravity PTY"). */
    private label: string,
    /** Whether a warm PTY still exists for a session — gates dropping the stream
     *  entry when the last subscriber detaches. */
    private hasWarmPty: (sessionId: string) => boolean,
  ) {}

  /** Wire a freshly-spawned PTY's output into the session's scrollback ring buffer
   *  + live subscribers; notify subscribers with a reset event on respawn; absorb
   *  node-pty socket errors. `onData` (optional) runs first on every data event. */
  attach(sessionId: string, proc: CuttlefishPty, onData?: () => void): void {
    const stream = this.streamFor(sessionId);
    // Distinguish initial spawn from respawn via a per-stream flag rather than
    // subscriber count — clients open their WS on mount (before the user sends
    // the first message that triggers spawn), so subscriber-count gating would
    // spuriously reset on the very first PTY for the session.
    // On respawn, only emit if there are subscribers (no one listens otherwise).
    if (!stream.hasSeenPty) {
      stream.hasSeenPty = true;
    } else if (stream.subscribers.size > 0) {
      for (const sub of stream.subscribers) {
        try { sub.control?.({ type: "reset" }); } catch { /* ignore */ }
      }
    }
    // node-pty's internal socket error handler (unixTerminal.js) throws synchronously when
    // proc.listeners('error').length < 2. Without this listener the count stays at 1 (the
    // internal handler), so any socket error (EIO on exit, EPIPE, etc.) propagates as an
    // uncaught exception and kills the daemon. Adding a handler here bumps the count to 2
    // and prevents the throw; we log it and let the engine's onExit path handle cleanup.
    (proc as any).on?.("error", (err: Error) => {
      logger.warn(`${this.label} socket error for session ${sessionId}: ${err.message}`);
    });

    proc.onData((d) => {
      onData?.();
      // Convert string to Buffer once; push to ring; evict head until under cap.
      const chunk = Buffer.from(d, "utf-8");
      stream.chunks.push(chunk);
      stream.totalBytes += chunk.length;
      while (stream.totalBytes > SCROLLBACK_CAP_BYTES && stream.chunks.length > 1) {
        const head = stream.chunks.shift()!;
        stream.totalBytes -= head.length;
      }
      // If a single chunk exceeds the cap, slice it down (rare; keeps invariant tight).
      if (stream.totalBytes > SCROLLBACK_CAP_BYTES && stream.chunks.length === 1) {
        const only = stream.chunks[0]!;
        const sliced = only.subarray(only.length - SCROLLBACK_CAP_BYTES);
        stream.chunks[0] = sliced;
        stream.totalBytes = sliced.length;
      }
      for (const sub of stream.subscribers) {
        try { sub.data(chunk); } catch { /* ignore subscriber errors */ }
      }
    });
  }

  /** Stream-side cleanup when the session's CURRENT PTY exits. Clears scrollback so
   *  a stale farewell (e.g. Claude's "Resume this session…" hint printed on SIGHUP
   *  shutdown) doesn't persist into the next PTY incarnation. If no WS subscribers
   *  are attached the entry is dead weight — drop it so the map doesn't leak entries
   *  for every session that ever ran. Subscribers, when present, are kept so a
   *  future respawn can notify them via the reset event. */
  onPtyExit(sessionId: string): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    s.chunks = [];
    s.totalBytes = 0;
    if (s.subscribers.size === 0) this.streams.delete(sessionId);
  }

  /** Append-only capped output buffer for the session's current/most-recent PTY (for
   *  xterm.js reconnect replay). Returns a concatenated Buffer — pty-ws.ts forwards
   *  it directly without re-encoding. */
  getScrollback(sessionId: string): Buffer {
    const s = this.streams.get(sessionId);
    if (!s || s.chunks.length === 0) return Buffer.alloc(0);
    return Buffer.concat(s.chunks, s.totalBytes);
  }

  /** Subscribe to live PTY output for a session. Returns an unsubscribe fn. Survives
   *  PTY respawn within the session. Optional `onControl` receives out-of-band events
   *  (currently just `{type:"reset"}` when the PTY is replaced mid-session — the WS
   *  should forward this to the client xterm). */
  subscribe(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): () => void {
    const stream = this.streamFor(sessionId);
    const sub: Subscriber = { data: cb, control: onControl };
    stream.subscribers.add(sub);
    return () => {
      stream.subscribers.delete(sub);
      // If this was the last subscriber AND there's no warm PTY producing data,
      // the streams entry is dead weight — drop it. Mirrors the onPtyExit cleanup
      // path for sessions whose WS outlived the PTY.
      if (stream.subscribers.size === 0 && !this.hasWarmPty(sessionId)) {
        this.streams.delete(sessionId);
      }
    };
  }

  /** Lazily create (or fetch) the output stream entry for a Cuttlefish session id.
   *  The map is LRU-capped at STREAM_MAP_CAP: entries that escape the explicit
   *  cleanup paths (e.g. a release that kills the PTY after the lifecycle entry
   *  is gone, so onExit's identity gate skips onPtyExit) are eventually evicted
   *  rather than pinning 256KB of scrollback forever. Every attach/subscribe
   *  refreshes recency, so only long-idle sessions lose their scrollback. */
  private streamFor(sessionId: string): StreamEntry {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = { chunks: [], totalBytes: 0, subscribers: new Set(), hasSeenPty: false };
    }
    setCapped(this.streams, sessionId, stream, STREAM_MAP_CAP);
    return stream;
  }
}

/** Wrap a live pty.IPty in a PtyHandle (the raw proc stashed on `_proc` for the
 *  engines' inject/resize/write paths). */
export function createPtyHandle(proc: CuttlefishPty): PtyHandle {
  const handle = {
    pid: proc.pid,
    get killed() { return (proc as any)._exitCode != null; },
    kill: (signal?: string) => { try { proc.kill(signal); } catch { /* already gone */ } },
  } as PtyHandle;
  (handle as any)._proc = proc;
  return handle;
}
