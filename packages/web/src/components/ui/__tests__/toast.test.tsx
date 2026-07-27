import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ToastProvider, useToast } from '../toast'

function TriggerButton() {
  const { pushToast } = useToast()
  return (
    <button onClick={() => pushToast({ title: 'Saved', durationMs: 1000 })}>
      push
    </button>
  )
}

// DESIGN-004 / WCAG 2.2.1 (Timing Adjustable): the auto-dismiss timer used to
// run unconditionally, giving no chance to pause it while reading/interacting.
describe('Toast auto-dismiss pause/resume', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('auto-dismisses after durationMs', () => {
    render(
      <ToastProvider>
        <TriggerButton />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('push'))
    expect(screen.getByText('Saved')).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('pauses the timer on hover and does not dismiss while hovered', () => {
    render(
      <ToastProvider>
        <TriggerButton />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('push'))
    const toast = screen.getByText('Saved').closest('[role="status"]') as HTMLElement

    act(() => {
      vi.advanceTimersByTime(500)
    })
    fireEvent.mouseEnter(toast)

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('resumes with only the remaining time after the hover ends', () => {
    render(
      <ToastProvider>
        <TriggerButton />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('push'))
    const toast = screen.getByText('Saved').closest('[role="status"]') as HTMLElement

    act(() => {
      vi.advanceTimersByTime(700)
    })
    fireEvent.mouseEnter(toast)
    act(() => {
      vi.advanceTimersByTime(5000) // paused — should not matter how long
    })
    fireEvent.mouseLeave(toast)

    // Only ~300ms should remain (1000 - 700 already elapsed before pause).
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(screen.getByText('Saved')).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.queryByText('Saved')).toBeNull()
  })
})
