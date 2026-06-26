import type { WebSocket } from "ws";

/** Interval between heartbeat sweeps. ~30s is the standard NAT/proxy keep-alive floor. */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

/** Minimal shape we need from a ws socket for liveness tracking. */
export interface HeartbeatSocket {
  isAlive?: boolean;
  readyState: number;
  ping(): void;
  terminate(): void;
}

/**
 * Mark a freshly-connected socket alive and refresh its liveness on every pong.
 * Call once per new connection.
 */
export function trackHeartbeat(ws: HeartbeatSocket & { on(event: "pong", cb: () => void): void }): void {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
}

/**
 * Run one heartbeat sweep over a set of sockets:
 *   - terminate() any socket still marked dead from the previous sweep
 *   - otherwise mark it provisionally dead and ping() it; the pong handler
 *     (installed by trackHeartbeat) flips it back to alive before the next sweep.
 * Returns counts for logging/testing.
 */
export function sweepHeartbeat(sockets: Iterable<HeartbeatSocket>): { terminated: number; pinged: number } {
  let terminated = 0;
  let pinged = 0;
  for (const ws of sockets) {
    if (ws.isAlive === false) {
      ws.terminate();
      terminated++;
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
      pinged++;
    } catch {
      // A ping on a socket mid-teardown can throw; it will be reaped next sweep.
    }
  }
  return { terminated, pinged };
}

/**
 * Start a periodic heartbeat across one or more WebSocketServer-like objects
 * (anything exposing a `clients` Set). Returns a stop function that clears the
 * timer. The timer is unref()'d so it never keeps the process alive.
 */
export function startWsHeartbeat(
  servers: Array<{ clients: Set<WebSocket> }>,
  opts?: { intervalMs?: number; onSweep?: (result: { terminated: number; pinged: number }) => void },
): () => void {
  const intervalMs = opts?.intervalMs ?? WS_HEARTBEAT_INTERVAL_MS;
  const timer = setInterval(() => {
    let terminated = 0;
    let pinged = 0;
    for (const server of servers) {
      const r = sweepHeartbeat(server.clients as unknown as Iterable<HeartbeatSocket>);
      terminated += r.terminated;
      pinged += r.pinged;
    }
    opts?.onSweep?.({ terminated, pinged });
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
