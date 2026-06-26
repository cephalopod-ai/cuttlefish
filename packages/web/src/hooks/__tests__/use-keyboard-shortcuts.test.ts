import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboardShortcuts, type ShortcutDef } from '../use-keyboard-shortcuts'

function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }))
}

describe('useKeyboardShortcuts', () => {
  describe('key matching', () => {
    it('fires action for matching single key', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('n')
      expect(action).toHaveBeenCalledOnce()
    })

    it('does not fire when wrong key pressed', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('x')
      expect(action).not.toHaveBeenCalled()
    })

    it('matches case-insensitively for letters', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('N')
      expect(action).toHaveBeenCalledOnce()
    })

    it('fires action for modifier shortcut', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'w', modifiers: ['meta'], category: 'Actions', description: 'Close tab', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('w', { metaKey: true })
      expect(action).toHaveBeenCalledOnce()
    })

    it('does not fire modifier shortcut without modifier', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'w', modifiers: ['meta'], category: 'Actions', description: 'Close tab', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('w')
      expect(action).not.toHaveBeenCalled()
    })

    it('does not fire single-key shortcut when modifier is held', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('n', { metaKey: true })
      expect(action).not.toHaveBeenCalled()
    })

    it('matches ? key (shift+/ produces ?)', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: '?', category: 'Help', description: 'Help', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('?', { shiftKey: true })
      expect(action).toHaveBeenCalledOnce()
    })

    it('skips disabled shortcuts', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action, enabled: false },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('n')
      expect(action).not.toHaveBeenCalled()
    })
  })

  describe('input guard', () => {
    afterEach(() => {
      document.body.innerHTML = ''
    })

    it('blocks single-key shortcuts when input is focused', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      fireKey('n')
      expect(action).not.toHaveBeenCalled()
    })

    it('blocks single-key shortcuts when textarea is focused', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))

      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      textarea.focus()

      fireKey('n')
      expect(action).not.toHaveBeenCalled()
    })

    it('allows modifier shortcuts when input is focused', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'w', modifiers: ['meta'], category: 'Actions', description: 'Close tab', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      fireKey('w', { metaKey: true })
      expect(action).toHaveBeenCalledOnce()
    })

    it('allows Escape when input is focused', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'Escape', category: 'Navigation', description: 'Close', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      fireKey('Escape')
      expect(action).toHaveBeenCalledOnce()
    })
  })

  describe('modal guard', () => {
    it('blocks all shortcuts except Escape when isModalOpen is true', () => {
      const nAction = vi.fn()
      const escAction = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action: nAction },
        { key: 'Escape', category: 'Navigation', description: 'Close', action: escAction },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts, { isModalOpen: true }))

      fireKey('n')
      expect(nAction).not.toHaveBeenCalled()

      fireKey('Escape')
      expect(escAction).toHaveBeenCalledOnce()
    })
  })

  describe('cleanup', () => {
    it('removes event listener on unmount', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      const { unmount } = renderHook(() => useKeyboardShortcuts(shortcuts))
      unmount()
      fireKey('n')
      expect(action).not.toHaveBeenCalled()
    })
  })
})
