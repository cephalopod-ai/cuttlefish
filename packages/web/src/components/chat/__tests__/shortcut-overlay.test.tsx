import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ShortcutOverlay } from '../shortcut-overlay'
import type { ShortcutDef } from '@/hooks/use-keyboard-shortcuts'

const shortcuts: ShortcutDef[] = [
  { key: 'j', category: 'Navigation', description: 'Next session', action: vi.fn() },
  { key: 'k', category: 'Navigation', description: 'Previous session', action: vi.fn() },
  { key: 'n', category: 'Actions', description: 'New chat', action: vi.fn() },
  { key: 'w', modifiers: ['meta'], category: 'Actions', description: 'Close tab', action: vi.fn() },
  { key: '?', category: 'Help', description: 'Toggle shortcuts', action: vi.fn() },
  { key: 'x', category: 'Actions', description: 'Disabled one', action: vi.fn(), enabled: false },
]

describe('ShortcutOverlay', () => {
  it('renders category headings', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    expect(screen.getByText('Navigation')).toBeTruthy()
    expect(screen.getByText('Actions')).toBeTruthy()
    expect(screen.getByText('Help')).toBeTruthy()
  })

  it('renders shortcut descriptions', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    expect(screen.getByText('Next session')).toBeTruthy()
    expect(screen.getByText('New chat')).toBeTruthy()
  })

  it('renders key badges with uppercase letters', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    expect(screen.getByText('J')).toBeTruthy()
    expect(screen.getByText('K')).toBeTruthy()
    expect(screen.getByText('N')).toBeTruthy()
  })

  it('renders modifier symbols', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    const badges = screen.getAllByText((_, el) => el?.textContent?.includes('⌘') ?? false)
    expect(badges.length).toBeGreaterThan(0)
  })

  it('hides disabled shortcuts', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    expect(screen.queryByText('Disabled one')).toBeNull()
  })

  it('has keyboard shortcuts heading', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    expect(screen.getByText('Keyboard Shortcuts')).toBeTruthy()
  })

  it('has correct aria attributes', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    const el = screen.getByRole('complementary')
    expect(el).toBeTruthy()
    expect(el.getAttribute('aria-label')).toBe('Keyboard shortcuts')
  })
})
