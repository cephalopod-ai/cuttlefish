import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createGatewaySocket,
  WS_PING_INTERVAL_MS,
  WS_WATCHDOG_TIMEOUT_MS,
} from '../ws'
import { WS_RECONNECT_MAX_MS } from '../ws-backoff'

/**
 * Minimal controllable WebSocket stand-in. jsdom doesn't implement WebSocket,
 * so we install this on globalThis and drive its lifecycle by hand.
 */
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  url: string
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  onopen: ((e?: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e?: unknown) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  // --- test driver helpers ---
  _open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }
  _emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
}

const live = () => FakeWebSocket.instances

describe('createGatewaySocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens a socket and reports isOpen + fires onOpen', () => {
    const onOpen = vi.fn()
    const sock = createGatewaySocket(() => {}, { onOpen })
    expect(live()).toHaveLength(1)
    expect(sock.isOpen()).toBe(false)
    live()[0]._open()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(sock.isOpen()).toBe(true)
    sock.close()
  })

  it('dispatches real events but swallows pong frames', () => {
    const onEvent = vi.fn()
    const sock = createGatewaySocket(onEvent)
    live()[0]._open()
    live()[0]._emit({ event: 'session:delta', payload: { a: 1 } })
    live()[0]._emit({ event: 'pong', payload: {} })
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith('session:delta', { a: 1 })
    sock.close()
  })

  it('sends a heartbeat ping on the ping interval', () => {
    const sock = createGatewaySocket(() => {})
    live()[0]._open()
    vi.advanceTimersByTime(WS_PING_INTERVAL_MS + 5)
    const pings = live()[0].sent.filter((s) => s.includes('"ping"'))
    expect(pings.length).toBeGreaterThanOrEqual(1)
    sock.close()
  })

  it('reaps a silent (half-open) socket via the watchdog and reconnects', () => {
    const sock = createGatewaySocket(() => {})
    live()[0]._open()
    expect(live()).toHaveLength(1)
    // No inbound frames for the whole watchdog window -> force close.
    vi.advanceTimersByTime(WS_WATCHDOG_TIMEOUT_MS + 5)
    expect(live()[0].readyState).toBe(FakeWebSocket.CLOSED)
    // Backoff reconnect fires within the max cap regardless of jitter.
    vi.advanceTimersByTime(WS_RECONNECT_MAX_MS + 5)
    expect(live().length).toBeGreaterThanOrEqual(2)
    sock.close()
  })

  it('does NOT reap a socket that keeps receiving frames', () => {
    const sock = createGatewaySocket(() => {})
    live()[0]._open()
    // Inbound traffic just before each watchdog deadline keeps it alive.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(WS_WATCHDOG_TIMEOUT_MS - 1000)
      live()[0]._emit({ event: 'tick', payload: {} })
    }
    expect(live()).toHaveLength(1)
    expect(live()[0].readyState).toBe(FakeWebSocket.OPEN)
    sock.close()
  })

  it('reconnect() reopens a dead socket and is a no-op when open', () => {
    const sock = createGatewaySocket(() => {})
    live()[0]._open()

    // No-op while open.
    sock.reconnect()
    expect(live()).toHaveLength(1)

    // Simulate a drop the client never noticed, then reconnect().
    live()[0].close()
    // onclose schedules a backoff reconnect; reconnect() should pre-empt it now.
    const beforeManual = live().length
    sock.reconnect()
    expect(live().length).toBe(beforeManual + 1)
    sock.close()
  })

  it('close() stops all reconnects', () => {
    const sock = createGatewaySocket(() => {})
    live()[0]._open()
    sock.close()
    const n = live().length
    vi.advanceTimersByTime(WS_WATCHDOG_TIMEOUT_MS + WS_RECONNECT_MAX_MS + 1000)
    expect(live().length).toBe(n)
  })

  it('reconnects after an unexpected close (server restart)', () => {
    const sock = createGatewaySocket(() => {})
    live()[0]._open()
    live()[0].close() // server went away
    vi.advanceTimersByTime(WS_RECONNECT_MAX_MS + 5)
    expect(live().length).toBeGreaterThanOrEqual(2)
    // New socket opens cleanly and resumes pinging.
    live()[live().length - 1]._open()
    vi.advanceTimersByTime(WS_PING_INTERVAL_MS + 5)
    expect(live()[live().length - 1].sent.some((s) => s.includes('"ping"'))).toBe(true)
    sock.close()
  })
})
