import type { WebSocket } from "ws";
import type { PtyViewEngine } from "../engines/pty-view-engine.js";
import { getSession } from "../sessions/registry.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

const RAW_KEY_INPUTS = new Set(["\r", "\x1b", "\t", "\x03", "\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"]);

/**
 * Attach a /ws/pty/:sessionId WebSocket to a session's interactive PTY stream.
 *
 * Lifecycle:
 *   - PTY spawn is DEFERRED until the client sends its first `{type:"resize"}`
 *     message so claude starts at the real terminal geometry. Eager-spawning
 *     at default 120×40 then resizing caused claude to lay text body at 120 cols
 *     and never reflow it back, producing "squished" rendering on mobile.
 *   - The frontend sends `{type:"viewing", viewing:true|false}` on mount, unmount, and
 *     Page Visibility changes. Each enter is ref-counted; when the count reaches zero
 *     (and no turn is running), the 10-min keep-alive grace window starts.
 *   - `viewing:true` triggers a follow-up resize from the client (see use-page-visibility
 *     effect in cli-terminal.tsx) which spawns/respawns the PTY at the correct geometry.
 *   - On `ws.close`, decrements the viewer count if this socket reported viewing.
 *     Does NOT directly kill the PTY — the lifecycle manager owns that.
 */
export function attachPtyWebSocket(ws: WebSocket, sessionId: string, engine: PtyViewEngine): void {
  let disconnected = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const closeWithError = (message: string) => {
    logger.warn(`PTY websocket for ${sessionId}: ${message}`);
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify({ type: "error", message })); } catch { /* ignore */ }
      ws.close();
    }
  };

  const spawnIfNeeded = (cols: number, rows: number): boolean => {
    try {
      const session = getSession(sessionId);
      engine.ensureIdleSpawn(sessionId, {
        engineSessionId: session?.engineSessionId ?? undefined,
        model: session?.model ?? undefined,
        effortLevel: session?.effortLevel ?? undefined,
        cwd: CUTTLEFISH_HOME,
        cols,
        rows,
      });
      return true;
    } catch (err) {
      closeWithError(`failed to start PTY: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  // Subscribe FIRST, then replay scrollback. Reverse order had a race window
  // between snapshot and subscribe where PTY bytes could be lost — the snapshot
  // was already captured (so the replay didn't have them) and the subscriber
  // wasn't attached yet (so the live forward missed them too). With this order
  // those bytes arrive via the subscriber, slightly out of order vs. scrollback
  // but never missing.
  const unsubscribe = engine.subscribeOutput(
    sessionId,
    (data) => { if (ws.readyState === ws.OPEN) ws.send(data); },
    (event) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event)); },
  );

  // Replay scrollback if the PTY is already warm from a prior connection.
  const scrollback = engine.getScrollback(sessionId);
  if (scrollback.length > 0 && ws.readyState === ws.OPEN) ws.send(scrollback);

  // Track whether this socket has reported viewing:true so close-cleanup can
  // decrement only if it actually incremented. Guards against double-decrement
  // on flaky reconnects.
  let didEnter = false;
  // The client sends `viewing:true` on WS open BEFORE its first resize. With
  // lazy spawn, the lifecycle entry doesn't exist yet, so a naïve setViewing
  // is silently dropped — and the freshly-spawned PTY starts with viewerCount=0
  // and gets reaped by the sweep timer within seconds. Buffer the viewing
  // state and apply it the moment the first resize creates the entry.
  let pendingViewing: boolean | null = null;
  let entryReady = false;

  const applyViewingWhenReady = (viewing: boolean, attempts = 20) => {
    if (disconnected) return;
    if (engine.hasWarmPty(sessionId)) {
      entryReady = true;
      applyViewing(viewing);
      return;
    }
    if (attempts <= 0) {
      pendingViewing = viewing;
      entryReady = false;
      return;
    }
    retryTimer = setTimeout(() => applyViewingWhenReady(viewing, attempts - 1), 100);
    retryTimer.unref?.();
  };

  const applyViewing = (viewing: boolean) => {
    if (disconnected) return;
    if (viewing && !didEnter) {
      engine.setViewing(sessionId, true);
      didEnter = true;
    } else if (!viewing && didEnter) {
      engine.setViewing(sessionId, false);
      didEnter = false;
    }
  };

  ws.on("message", (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.type === "stdin" && typeof msg.data === "string") {
      engine.writeStdin(sessionId, msg.data);
    } else if (msg?.type === "key" && typeof msg.data === "string") {
      if (RAW_KEY_INPUTS.has(msg.data)) engine.writeRaw(sessionId, msg.data);
    } else if (msg?.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
      // First resize spawns the PTY at the real client geometry; subsequent
      // resizes just forward SIGWINCH to claude.
      const hadWarmPty = engine.hasWarmPty(sessionId);
      if (!spawnIfNeeded(msg.cols, msg.rows)) return;
      try {
        engine.resizePty(sessionId, msg.cols, msg.rows);
      } catch (err) {
        closeWithError(`failed to resize PTY: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!entryReady && hadWarmPty) {
        entryReady = true;
        if (pendingViewing !== null) {
          applyViewing(pendingViewing);
          pendingViewing = null;
        }
      } else if (!entryReady && pendingViewing !== null) {
        const viewing = pendingViewing;
        pendingViewing = null;
        applyViewingWhenReady(viewing);
      }
    } else if (msg?.type === "viewing" && typeof msg.viewing === "boolean") {
      if (!entryReady) {
        // Stash for after first resize triggers spawn.
        pendingViewing = msg.viewing;
        return;
      }
      applyViewing(msg.viewing);
    }
  });

  const onDisconnect = () => {
    if (disconnected) return;
    disconnected = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    pendingViewing = null;
    unsubscribe();
    if (didEnter) {
      engine.setViewing(sessionId, false);
      didEnter = false;
    }
  };
  ws.on("close", onDisconnect);
  ws.on("error", onDisconnect);
}
