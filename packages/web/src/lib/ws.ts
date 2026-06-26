import { dlog } from "./debug-log";
import { nextReconnectDelay } from "./ws-backoff";

type EventHandler = (event: string, payload: unknown) => void;

/**
 * App-level ping cadence. Keeps idle NAT/proxy/Tailscale flows warm and — paired
 * with the gateway's `ping`→`pong` echo — lets the watchdog observe server
 * liveness during quiet periods (a browser can't see protocol-level pongs).
 */
export const WS_PING_INTERVAL_MS = 25_000;
/**
 * If no frame (a `pong` or any real event) arrives within this window the socket
 * is presumed half-open and force-closed to trigger a reconnect. Must be safely
 * larger than the ping cadence so a healthy-but-idle socket is never reaped.
 */
export const WS_WATCHDOG_TIMEOUT_MS = 60_000;

/** WebSocket.OPEN, hoisted so this module doesn't depend on the global at parse time. */
const WS_OPEN = 1;

export interface GatewaySocket {
  /** Permanently close the socket and stop all timers/reconnects. */
  close: () => void;
  /** Reconnect now if the socket isn't already open (clears any pending backoff). */
  reconnect: () => void;
  /** Whether the underlying socket is currently OPEN. */
  isOpen: () => boolean;
}

export function createGatewaySocket(
  onEvent: EventHandler,
  opts?: { onOpen?: () => void; onClose?: () => void },
): GatewaySocket {
  const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
  const wsUrl = gatewayUrl
    ? `${gatewayUrl.replace(/^http/, "ws")}/ws`
    : typeof window !== "undefined"
      ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`
      : "ws://127.0.0.1:8888/ws";

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;

  function clearLiveTimers() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  // (Re)arm the silence watchdog. Called on open and on every inbound frame, so
  // a steady stream of events (or pongs) keeps it from ever firing.
  function armWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      dlog("ws", "watchdog timeout — socket silent, forcing reconnect");
      // Force-close; the socket's onclose schedules the backoff reconnect.
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    }, WS_WATCHDOG_TIMEOUT_MS);
  }

  function startPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WS_OPEN) {
        try {
          ws.send(JSON.stringify({ event: "ping" }));
        } catch (err) {
          dlog("ws", `ping send failed: ${String(err)}`);
        }
      }
    }, WS_PING_INTERVAL_MS);
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = nextReconnectDelay(attempt++);
    dlog("ws", `reconnect scheduled in ${delay}ms (attempt ${attempt})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (closed) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    let sock: WebSocket;
    try {
      sock = new WebSocket(wsUrl);
    } catch (err) {
      dlog("ws", `construct failed: ${String(err)}`);
      scheduleReconnect();
      return;
    }
    ws = sock;

    // All handlers are guarded by `sock !== ws`: once we replace `ws` (manual
    // reconnect, or a fresh connect after close), the previous socket's late
    // events become no-ops instead of spawning duplicate reconnects.
    sock.onopen = () => {
      if (sock !== ws) return;
      attempt = 0;
      armWatchdog();
      startPing();
      opts?.onOpen?.();
    };
    sock.onmessage = (e) => {
      if (sock !== ws) return;
      armWatchdog(); // any inbound byte proves the path is alive
      try {
        const data = JSON.parse(e.data);
        if (data?.event === "pong") return; // liveness only — nothing to dispatch
        onEvent(data.event, data.payload);
      } catch (err) {
        dlog("ws", `dropped malformed frame: ${String(err)}`);
      }
    };
    sock.onclose = () => {
      if (sock !== ws) return;
      clearLiveTimers();
      opts?.onClose?.();
      scheduleReconnect();
    };
    sock.onerror = () => {
      if (sock !== ws) return;
      dlog("ws", "socket error");
      sock.close();
    };
  }

  function reconnectNow() {
    if (closed) return;
    if (ws && ws.readyState === WS_OPEN) return; // already healthy
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    attempt = 0;
    // Drop any half-open/connecting socket; its handlers no-op via the identity
    // guard once connect() reassigns `ws`.
    const stale = ws;
    ws = null;
    clearLiveTimers();
    if (stale && stale.readyState !== 3 /* CLOSED */) {
      try {
        stale.close();
      } catch {
        /* ignore */
      }
    }
    connect();
  }

  connect();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearLiveTimers();
      ws?.close();
    },
    reconnect: reconnectNow,
    isOpen: () => ws !== null && ws.readyState === WS_OPEN,
  };
}
