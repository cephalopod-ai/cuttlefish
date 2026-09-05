import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { ChatInput } from '../chat-input'

vi.mock('@/lib/api', () => ({ api: { getOrg: async () => ({ employees: [] }), getSkills: async () => [] } }))
vi.mock('@/hooks/use-stt', () => ({ useStt: () => ({ state: 'idle', languages: [], selectedLanguage: 'en' }) }))
vi.mock('@/components/stt/whisper-download-modal', () => ({ WhisperDownloadModal: () => null }))
vi.mock('../chat-input-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../chat-input-utils')>(),
  fileToAttachment: async (file: File) => ({ type: 'file', name: file.name, file, url: 'data:text/plain;base64,cmVwb3J0' }),
}))

function renderInput(onSend: ComponentProps<typeof ChatInput>['onSend'], droppedFiles?: File[]) {
  return render(<ChatInput disabled={false} loading={false} onSend={onSend} onNewSession={() => {}} onStatusRequest={() => {}} droppedFiles={droppedFiles} />)
}

describe('chat send acceptance', () => {
  it('retains the draft and file through rejection, then clears them after an accepted retry', async () => {
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const file = new File(['report'], 'report.txt', { type: 'text/plain' })
    renderInput(onSend, [file])
    await screen.findByRole('button', { name: 'Remove attachment' })
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Review this report' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })

    expect(input.value).toBe('Review this report')
    expect(screen.getByRole('button', { name: 'Remove attachment' })).toBeTruthy()
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(onSend).toHaveBeenCalledTimes(2)
    expect(onSend.mock.calls[1][1][0].file).toBe(file)
    expect(input.value).toBe('')
    expect(screen.queryByRole('button', { name: 'Remove attachment' })).toBeNull()
  })

  it('keeps the draft until acknowledgment and prevents duplicate submissions while it is pending', async () => {
    let accept!: (value: boolean) => void
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { accept = resolve }))
    renderInput(onSend)
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'One request' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('One request')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    await act(async () => accept(true))
    expect(input.value).toBe('')
  })

  it('sends an explicit review prompt when the operator submits only files', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    renderInput(onSend, [new File(['report'], 'report.txt', { type: 'text/plain' })])
    await screen.findByRole('button', { name: 'Remove attachment' })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Please review the attached files.', expect.any(Array), false))
  })

  it('shows a rejected send error and retains the text for retry', async () => {
    renderInput(vi.fn().mockRejectedValue(new Error('Network unavailable')))
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Keep this text' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(screen.getByRole('alert').textContent).toBe('Network unavailable')
    expect(input.value).toBe('Keep this text')
  })
})
