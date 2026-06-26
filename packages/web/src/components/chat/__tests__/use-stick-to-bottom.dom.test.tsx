import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import { useStickToBottom, STICK_THRESHOLD_PX } from '@/hooks/use-stick-to-bottom'

// Drives the REAL hook through every scroll failure mode the rebuild targets.
// jsdom has no layout engine, so we install controllable scrollHeight/clientHeight/
// scrollTop on the container and a captured ResizeObserver, then assert the hook's
// observable behaviour (does it pin? does it preserve position? jump/unread state).

let roInstances: Array<{ cb: ResizeObserverCallback }> = []

beforeEach(() => {
  roInstances = []
  // Run rAF synchronously so the hook's coalesced UI updates land within act().
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class {
    cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) { this.cb = cb; roInstances.push({ cb }) }
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function Harness(props: { streamingText?: string; messageCount: number }) {
  const { containerRef, showJump, unreadCount, scrollToBottom } = useStickToBottom(props)
  return (
    <div>
      <div data-testid="scroller" ref={containerRef}>
        <div>content</div>
      </div>
      <span data-testid="jump">{showJump ? 'show' : 'hide'}</span>
      <span data-testid="unread">{unreadCount}</span>
      <button data-testid="btn" onClick={() => scrollToBottom('auto')}>jump</button>
    </div>
  )
}

/** Install controllable scroll metrics on the element (jsdom defaults them to 0). */
function setMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop = 0) {
  let top = scrollTop
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v } })
}

function dist(el: HTMLElement) {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
}

describe('useStickToBottom — behaviour', () => {
  it('mount-snap: pins to the bottom the first time messages appear', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) })
    expect(dist(el)).toBe(0) // pinned
  })

  it('streaming-follow: stays pinned as content grows while at the bottom', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} streamingText="" />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} streamingText="" />) })
    expect(dist(el)).toBe(0)
    // Content grows over several stream ticks — must remain pinned (no detach).
    for (const [h, text] of [[1400, 'a'], [2200, 'ab'], [3600, 'abc']] as const) {
      setMetrics(el, h, 200, el.scrollTop)
      act(() => { rerender(<Harness messageCount={5} streamingText={text} />) })
      expect(dist(el)).toBe(0)
    }
  })

  it('read-up-preserve: scrolling up detaches and a later message does NOT yank back', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) }) // caught up, seen=5
    // User scrolls up well past the threshold.
    act(() => { el.scrollTop = 300; fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('show')
    const posBeforeGrowth = el.scrollTop
    // A new message arrives while reading up — position must be preserved.
    setMetrics(el, 1600, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={6} />) })
    expect(el.scrollTop).toBe(posBeforeGrowth) // not yanked
    expect(getByTestId('unread').textContent).toBe('1') // one new message counted
  })

  it('threshold: within STICK_THRESHOLD_PX still counts as at-bottom (re-engages follow)', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) })
    // Detach first.
    act(() => { el.scrollTop = 200; fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('show')
    // Nudge back to within the threshold of the bottom (dist = 1000-790-200 = 10).
    act(() => { el.scrollTop = 1000 - 200 - (STICK_THRESHOLD_PX - 1); fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('hide')
  })

  it('resize/keyboard: a viewport resize re-pins while following', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) }) // following
    // Simulate the mobile keyboard: content unchanged, but the container shrank and
    // drifted off the bottom. The viewport ResizeObserver must re-pin.
    el.scrollTop = 600
    act(() => { roInstances.forEach((r) => r.cb([], {} as ResizeObserver)) })
    expect(dist(el)).toBe(0)
  })

  it('tab-return: visibilitychange re-pins while following', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) }) // following
    el.scrollTop = 500 // drift accrued while backgrounded
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    act(() => { fireEvent(document, new Event('visibilitychange')) })
    expect(dist(el)).toBe(0)
  })

  it('jump button: returns to bottom, hides itself, and clears unread', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) })
    act(() => { el.scrollTop = 100; fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('show')
    act(() => { fireEvent.click(getByTestId('btn')) })
    expect(dist(el)).toBe(0)
    expect(getByTestId('jump').textContent).toBe('hide')
    expect(getByTestId('unread').textContent).toBe('0')
  })

  it('unread accumulates per new message while detached', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) })
    act(() => { el.scrollTop = 100; fireEvent.scroll(el) }) // detach, seen=5
    setMetrics(el, 1200, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={6} />) })
    expect(getByTestId('unread').textContent).toBe('1')
    setMetrics(el, 1400, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={7} />) })
    expect(getByTestId('unread').textContent).toBe('2')
  })
})
