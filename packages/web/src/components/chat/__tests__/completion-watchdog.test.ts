import { describe, it, expect } from 'vitest'

/**
 * Tests the pure decision used by ChatPane's post-reconnect completion watchdog.
 * The watchdog recovers from a dropped session:completed WS frame: after a
 * reconnect, if a turn is still loading but has been silent past the watchdog
 * window AND the server reports the turn is no longer running, the spinner is
 * stuck and must be cleared.
 */
import { shouldRecoverStuckTurn } from '../chat-pane'

describe('shouldRecoverStuckTurn', () => {
  it('returns false when not loading', () => {
    expect(
      shouldRecoverStuckTurn({
        loading: false,
        msSinceLastDelta: 999_999,
        serverStatus: 'idle',
      })
    ).toBe(false)
  })

  it('returns false when loading but a delta arrived recently (still streaming)', () => {
    expect(
      shouldRecoverStuckTurn({
        loading: true,
        msSinceLastDelta: 1_000,
        serverStatus: 'idle',
      })
    ).toBe(false)
  })

  it('returns false when loading + silent but server still reports running', () => {
    expect(
      shouldRecoverStuckTurn({
        loading: true,
        msSinceLastDelta: 20_000,
        serverStatus: 'running',
      })
    ).toBe(false)
  })

  it('returns true when loading + silent + server idle (missed completion)', () => {
    expect(
      shouldRecoverStuckTurn({
        loading: true,
        msSinceLastDelta: 20_000,
        serverStatus: 'idle',
      })
    ).toBe(true)
  })

  it('returns true when loading + silent + server completed', () => {
    expect(
      shouldRecoverStuckTurn({
        loading: true,
        msSinceLastDelta: 20_000,
        serverStatus: 'completed',
      })
    ).toBe(true)
  })

  it('returns true when loading + silent + server error', () => {
    expect(
      shouldRecoverStuckTurn({
        loading: true,
        msSinceLastDelta: 20_000,
        serverStatus: 'error',
      })
    ).toBe(true)
  })

  it('treats an undefined server status as non-running (recover)', () => {
    expect(
      shouldRecoverStuckTurn({
        loading: true,
        msSinceLastDelta: 20_000,
        serverStatus: undefined,
      })
    ).toBe(true)
  })

  it('respects a custom watchdogMs threshold', () => {
    // 5s of silence is below a 10s window → not yet stuck.
    expect(
      shouldRecoverStuckTurn({
        loading: true,
        msSinceLastDelta: 5_000,
        serverStatus: 'idle',
        watchdogMs: 10_000,
      })
    ).toBe(false)
    // 5s of silence is at/above a 4s window → stuck.
    expect(
      shouldRecoverStuckTurn({
        loading: true,
        msSinceLastDelta: 5_000,
        serverStatus: 'idle',
        watchdogMs: 4_000,
      })
    ).toBe(true)
  })
})
