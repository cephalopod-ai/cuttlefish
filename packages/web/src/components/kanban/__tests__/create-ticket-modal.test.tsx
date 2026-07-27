import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CreateTicketModal } from '../create-ticket-modal'

// DESIGN-005: the priority/complexity toggle-button groups had no
// aria-pressed, so a screen-reader user had no way to tell which option was
// currently selected — the visual border/fill difference carried no
// accessible signal.
describe('CreateTicketModal priority/complexity toggle groups (DESIGN-005)', () => {
  it('reflects the selected priority via aria-pressed', () => {
    render(
      <CreateTicketModal open onOpenChange={vi.fn()} employees={[]} onSubmit={vi.fn()} />,
    )

    const medium = screen.getAllByRole('button', { name: 'Medium' })[0]
    expect(medium.getAttribute('aria-pressed')).toBe('true')
    const low = screen.getAllByRole('button', { name: 'Low' })[0]
    expect(low.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(low)
    expect(low.getAttribute('aria-pressed')).toBe('true')
    expect(medium.getAttribute('aria-pressed')).toBe('false')
  })

  it('reflects the selected complexity via aria-pressed', () => {
    render(
      <CreateTicketModal open onOpenChange={vi.fn()} employees={[]} onSubmit={vi.fn()} />,
    )

    const mediumButtons = screen.getAllByRole('button', { name: 'Medium' })
    const complexityMedium = mediumButtons[1]
    expect(complexityMedium.getAttribute('aria-pressed')).toBe('true')

    const highButtons = screen.getAllByRole('button', { name: 'High' })
    const complexityHigh = highButtons[1]
    fireEvent.click(complexityHigh)
    expect(complexityHigh.getAttribute('aria-pressed')).toBe('true')
    expect(complexityMedium.getAttribute('aria-pressed')).toBe('false')
  })
})
