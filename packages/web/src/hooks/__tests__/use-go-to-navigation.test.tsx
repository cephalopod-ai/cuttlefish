import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useGoToNavigation, GO_TO_TARGETS } from '../use-go-to-navigation'

const navigateMock = vi.fn()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigateMock }
})

function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }))
}

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>
}

describe('useGoToNavigation', () => {
  afterEach(() => {
    navigateMock.mockReset()
    document.body.innerHTML = ''
  })

  it('navigates on g then a mapped key', () => {
    renderHook(() => useGoToNavigation(), { wrapper })
    fireKey('g')
    fireKey('o')
    expect(navigateMock).toHaveBeenCalledWith('/org')
  })

  it('covers every GO_TO_TARGETS entry', () => {
    renderHook(() => useGoToNavigation(), { wrapper })
    for (const target of GO_TO_TARGETS) {
      navigateMock.mockReset()
      fireKey('g')
      fireKey(target.key)
      expect(navigateMock).toHaveBeenCalledWith(target.href)
    }
  })

  it('does nothing for g alone', () => {
    renderHook(() => useGoToNavigation(), { wrapper })
    fireKey('g')
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('disarms after an unmapped key follows g', () => {
    renderHook(() => useGoToNavigation(), { wrapper })
    fireKey('g')
    fireKey('q') // not in GO_TO_TARGETS
    fireKey('o') // arrives un-armed — must NOT navigate
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('does not arm when a modifier is held on g', () => {
    renderHook(() => useGoToNavigation(), { wrapper })
    fireKey('g', { metaKey: true })
    fireKey('o')
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('ignores g while typing in an input', () => {
    renderHook(() => useGoToNavigation(), { wrapper })
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    fireKey('g')
    fireKey('o')
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('ignores g while a dialog is open', () => {
    renderHook(() => useGoToNavigation(), { wrapper })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)

    fireKey('g')
    fireKey('o')
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('does nothing when disabled', () => {
    renderHook(() => useGoToNavigation(false), { wrapper })
    fireKey('g')
    fireKey('o')
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('removes its listener on unmount', () => {
    const { unmount } = renderHook(() => useGoToNavigation(), { wrapper })
    unmount()
    fireKey('g')
    fireKey('o')
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
