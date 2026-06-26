import { describe, it, expect } from 'vitest'
import {
  nextReconnectDelay,
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_MAX_MS,
} from '../ws-backoff'

describe('nextReconnectDelay', () => {
  it('returns the window floor (half) when rng() === 0', () => {
    expect(nextReconnectDelay(0, () => 0)).toBe(WS_RECONNECT_BASE_MS / 2)
    expect(nextReconnectDelay(1, () => 0)).toBe(WS_RECONNECT_BASE_MS) // window 2000 -> half 1000
  })

  it('returns the full window when rng() approaches 1', () => {
    expect(nextReconnectDelay(0, () => 1)).toBe(WS_RECONNECT_BASE_MS)
    expect(nextReconnectDelay(2, () => 1)).toBe(WS_RECONNECT_BASE_MS * 4) // window 4000
  })

  it('grows exponentially across attempts', () => {
    const mid = () => 0.5
    const d0 = nextReconnectDelay(0, mid)
    const d1 = nextReconnectDelay(1, mid)
    const d2 = nextReconnectDelay(2, mid)
    expect(d1).toBeGreaterThan(d0)
    expect(d2).toBeGreaterThan(d1)
  })

  it('never exceeds the max cap, even for large attempts', () => {
    for (let a = 0; a < 40; a++) {
      expect(nextReconnectDelay(a, () => 1)).toBeLessThanOrEqual(WS_RECONNECT_MAX_MS)
    }
  })

  it('caps the window so the floor is max/2 once saturated', () => {
    // attempt 10 -> base*1024 = 1_024_000, clamped to max 30_000.
    expect(nextReconnectDelay(10, () => 0)).toBe(WS_RECONNECT_MAX_MS / 2)
    expect(nextReconnectDelay(10, () => 1)).toBe(WS_RECONNECT_MAX_MS)
  })

  it('treats negative attempts as 0', () => {
    expect(nextReconnectDelay(-5, () => 0)).toBe(WS_RECONNECT_BASE_MS / 2)
  })

  it('respects custom base/max', () => {
    expect(nextReconnectDelay(0, () => 0, { baseMs: 200, maxMs: 5000 })).toBe(100)
    expect(nextReconnectDelay(20, () => 1, { baseMs: 200, maxMs: 5000 })).toBe(5000)
  })

  it('always returns a value within [window/2, window]', () => {
    for (let a = 0; a < 8; a++) {
      const window = Math.min(WS_RECONNECT_MAX_MS, WS_RECONNECT_BASE_MS * 2 ** a)
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const d = nextReconnectDelay(a, () => r)
        expect(d).toBeGreaterThanOrEqual(Math.round(window / 2))
        expect(d).toBeLessThanOrEqual(window)
      }
    }
  })
})
