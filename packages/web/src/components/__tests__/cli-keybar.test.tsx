import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CliKeybar, CLI_KEYS } from '../chat/cli-keybar'

// Mirror of the backend allowlist in packages/cuttlefish/src/gateway/pty-ws.ts
// (RAW_KEY_INPUTS). Kept here as a parity guard: every sequence the keybar can
// emit MUST be one the backend will accept, otherwise the keypress is silently
// dropped at the WS boundary.
const BACKEND_ALLOWLIST = new Set(['\r', '\x1b', '\t', '\x03', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D'])

describe('CliKeybar', () => {
  function openKeybar(onKey = vi.fn()) {
    render(<CliKeybar onKey={onKey} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal keys' }))
    return onKey
  }

  it('starts collapsed behind a terminal keys button', () => {
    render(<CliKeybar onKey={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Terminal keys' })).toBeTruthy()
    expect(screen.queryByRole('toolbar', { name: 'Terminal keys' })).toBeNull()
  })

  it('renders a compact toolbar for every defined key after opening', () => {
    openKeybar()
    for (const k of CLI_KEYS) {
      expect(screen.getByRole('button', { name: k.aria })).toBeTruthy()
    }
  })

  it('can render as a compact hint control', () => {
    render(<CliKeybar variant="hint" onKey={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Terminal keys' })
    expect(trigger.textContent).toContain('terminal')
    fireEvent.click(trigger)
    expect(screen.getByRole('toolbar', { name: 'Terminal keys' })).toBeTruthy()
  })

  it('every emitted sequence is in the backend allowlist (parity guard)', () => {
    for (const k of CLI_KEYS) {
      expect(BACKEND_ALLOWLIST.has(k.data)).toBe(true)
    }
  })

  it('emits Enter as \\r', () => {
    const onKey = vi.fn()
    openKeybar(onKey)
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }))
    expect(onKey).toHaveBeenCalledWith('\r')
  })

  it('emits Escape as \\x1b', () => {
    const onKey = vi.fn()
    openKeybar(onKey)
    fireEvent.click(screen.getByRole('button', { name: 'Escape' }))
    expect(onKey).toHaveBeenCalledWith('\x1b')
  })

  it('emits Tab as \\t', () => {
    const onKey = vi.fn()
    openKeybar(onKey)
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }))
    expect(onKey).toHaveBeenCalledWith('\t')
  })

  it('emits the four arrow escape sequences', () => {
    const onKey = vi.fn()
    openKeybar(onKey)
    fireEvent.click(screen.getByRole('button', { name: 'Arrow up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Arrow down' }))
    fireEvent.click(screen.getByRole('button', { name: 'Arrow left' }))
    fireEvent.click(screen.getByRole('button', { name: 'Arrow right' }))
    expect(onKey.mock.calls.map((c) => c[0])).toEqual(['\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C'])
  })

  it('uses the X button to close the toolbar without sending Ctrl-C', () => {
    const onKey = vi.fn()
    openKeybar(onKey)
    fireEvent.click(screen.getByRole('button', { name: 'Close terminal keys' }))
    expect(screen.queryByRole('toolbar', { name: 'Terminal keys' })).toBeNull()
    expect(onKey).not.toHaveBeenCalled()
  })

  it('exposes a labelled toolbar for assistive tech', () => {
    openKeybar()
    const toolbar = screen.getByRole('toolbar', { name: 'Terminal keys' })
    expect(toolbar).toBeTruthy()
  })

  it('closes when clicking outside', () => {
    openKeybar()
    expect(screen.getByRole('toolbar', { name: 'Terminal keys' })).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('toolbar', { name: 'Terminal keys' })).toBeNull()
  })

  it('closes when pressing Escape', () => {
    openKeybar()
    expect(screen.getByRole('toolbar', { name: 'Terminal keys' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('toolbar', { name: 'Terminal keys' })).toBeNull()
  })
})
