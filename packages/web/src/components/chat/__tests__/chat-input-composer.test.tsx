import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createRef } from 'react'
import { ChatInputComposer } from '../chat-input-composer'
import type { useStt } from '@/hooks/use-stt'

type SttState = ReturnType<typeof useStt>

function makeStt(overrides: Partial<SttState> = {}): SttState {
  return {
    state: 'idle',
    available: true,
    downloadProgress: null,
    analyser: null,
    languages: ['en'],
    selectedLanguage: 'en',
    error: null,
    cycleLanguage: vi.fn(),
    handleMicClick: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
    startDownload: vi.fn(),
    dismissDownload: vi.fn(),
    dismissError: vi.fn(),
    ...overrides,
  } as SttState
}

function renderComposer(overrides: Partial<Parameters<typeof ChatInputComposer>[0]> = {}) {
  const onMicKeyDown = vi.fn()
  render(
    <ChatInputComposer
      disabled={false}
      loading={false}
      value=""
      hasContent={false}
      textareaRef={createRef<HTMLTextAreaElement>()}
      fileInputRef={createRef<HTMLInputElement>()}
      stt={makeStt()}
      onChange={() => {}}
      onKeyDown={() => {}}
      onPaste={() => {}}
      onInput={() => {}}
      onFileAttach={() => {}}
      onMicPointerDown={() => {}}
      onMicPointerUp={() => {}}
      onMicKeyDown={onMicKeyDown}
      onSubmit={() => {}}
      {...overrides}
    />,
  )
  return { onMicKeyDown }
}

// DESIGN-001: the mic button previously wired only pointer events, so it was
// completely unreachable via keyboard. Verify onKeyDown is actually attached
// to the button (the wiring the original defect lacked), not just present as
// a prop that's never forwarded to the DOM element.
describe('ChatInputComposer — mic button keyboard reachability (DESIGN-001)', () => {
  it('forwards Enter on the mic button to onMicKeyDown', () => {
    const { onMicKeyDown } = renderComposer()
    const mic = screen.getByRole('button', { name: 'Voice input' })
    fireEvent.keyDown(mic, { key: 'Enter' })
    expect(onMicKeyDown).toHaveBeenCalledTimes(1)
  })

  it('forwards Space on the mic button to onMicKeyDown', () => {
    const { onMicKeyDown } = renderComposer()
    const mic = screen.getByRole('button', { name: 'Voice input' })
    fireEvent.keyDown(mic, { key: ' ' })
    expect(onMicKeyDown).toHaveBeenCalledTimes(1)
  })

  it('the mic button is a real, unmodified <button> — reachable in the tab order and activatable by default browser Enter/Space semantics', () => {
    renderComposer()
    const mic = screen.getByRole('button', { name: 'Voice input' })
    expect(mic.tagName).toBe('BUTTON')
    expect(mic.getAttribute('tabindex')).not.toBe('-1')
  })
})
