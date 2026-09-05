import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import type { MediaAttachment } from '@/lib/conversations'
import { ChatPane } from '../chat-pane'

const apiMocks = vi.hoisted(() => ({ createSession: vi.fn(), sendMessage: vi.fn(), uploadFile: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: apiMocks }))
const sendResult = vi.fn()
let sendMedia: MediaAttachment[] | undefined

vi.mock('@/hooks/use-employees', () => {
  const org = { data: { employees: [] } }
  const workspaces = { data: { profiles: [] } }
  return { useOrg: () => org, useWorkspaceProfiles: () => workspaces }
})

interface LiveSessionMockState {
  messages: unknown[]
  streamingText: string
  loading: boolean
  hydrating: boolean
  session: Record<string, unknown> | null
  error: Error | null
  liveContextTokens: number | null
  backgroundActivity: unknown
  reload: ReturnType<typeof vi.fn>
  beginSend: ReturnType<typeof vi.fn>
  failSend: ReturnType<typeof vi.fn>
  appendLocal: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

const liveSessionDefaults: LiveSessionMockState = {
  messages: [],
  streamingText: '',
  loading: false,
  hydrating: false,
  session: { id: 's1', status: 'idle', engine: 'claude', model: 'opus' },
  error: null,
  liveContextTokens: null,
  backgroundActivity: null,
  reload: vi.fn(),
  beginSend: vi.fn(),
  failSend: vi.fn(),
  appendLocal: vi.fn(),
  reset: vi.fn(),
}

let liveSessionState: LiveSessionMockState

vi.mock('@/hooks/use-live-session', () => ({
  useLiveSession: () => liveSessionState,
}))

vi.mock('@/components/chat/chat-input', () => ({
  ChatInput: ({ selectorSlot, onSend }: { selectorSlot?: React.ReactNode; onSend: (message: string, media?: MediaAttachment[]) => Promise<boolean> }) => (
    <div data-testid="chat-input">{selectorSlot}<button type="button" onClick={() => { void onSend('Draft message', sendMedia).then(sendResult) }}>submit draft</button></div>
  ),
}))

vi.mock('@/components/chat/model-selector-row', () => ({
  ModelSelectorRow: ({ onNewChat }: { onNewChat?: () => void }) => (
    <button type="button" onClick={onNewChat}>selector new chat</button>
  ),
}))

vi.mock('@/components/chat/chat-messages', () => ({
  ChatMessages: () => <div data-testid="messages" />,
}))

vi.mock('@/components/chat/chat-employee-picker', () => ({
  ChatEmployeePicker: () => <div data-testid="employee-picker" />,
}))

vi.mock('@/components/chat/queue-panel', () => ({
  QueuePanel: () => null,
}))

vi.mock('@/components/chat/background-activity-pill', () => ({
  BackgroundActivityPill: () => null,
}))

vi.mock('@/components/chat/session-human-review', () => ({
  SessionHumanReview: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="session-human-review">{sessionId}</div>
  ),
}))

vi.mock('@/components/chat/archive-dialog', () => ({
  ArchiveDialog: () => null,
}))

vi.mock('@/components/chat/cli-keybar', () => ({
  CliKeybar: () => null,
}))

function renderPane(props: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
  return render(
    <ChatPane
      sessionId="s1"
      isActive
      onFocus={() => {}}
      subscribe={() => () => {}}
      events={[]}
      {...props}
    />,
  )
}

describe('ChatPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.createSession.mockResolvedValue({ id: 'created-session' })
    apiMocks.sendMessage.mockResolvedValue({ status: 'queued' })
    apiMocks.uploadFile.mockResolvedValue({ id: 'uploaded-file' })
    sendMedia = undefined
    liveSessionState = { ...liveSessionDefaults }
  })
  afterEach(() => vi.restoreAllMocks())

  it('routes existing-chat engine switching to the parent new-chat flow', () => {
    const onNewChat = vi.fn()
    renderPane({ onNewChat })

    fireEvent.click(screen.getByRole('button', { name: /selector new chat/i }))

    expect(onNewChat).toHaveBeenCalledTimes(1)
  })

  it('shows a lightweight loading status instead of an empty new-chat picker while a session hydrates', () => {
    liveSessionState = { ...liveSessionDefaults, hydrating: true, session: null }

    renderPane()

    expect(screen.getByRole('status', { name: /loading chat/i })).toBeTruthy()
    expect(screen.queryByTestId('employee-picker')).toBeNull()
  })

  it('renders the session-scoped human review strip for the active chat', () => {
    renderPane({ sessionId: 'hr-session-1' })

    expect(screen.getByTestId('session-human-review').textContent).toBe('hr-session-1')
  })

  it.each([true, false])('reports a rejected API request to the composer (new chat=%s)', async (newChat) => {
    const failure = new Error('Gateway unavailable')
    if (newChat) apiMocks.createSession.mockRejectedValueOnce(failure)
    else apiMocks.sendMessage.mockRejectedValueOnce(failure)
    renderPane({ sessionId: newChat ? null : 's1' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'submit draft' })) })
    expect(sendResult).toHaveBeenCalledWith(false)
    expect(liveSessionState.failSend).toHaveBeenCalledWith('Error: Gateway unavailable')
  })

  it('reports failed uploads without submitting a message that omits its attachment', async () => {
    const file = new File(['report'], 'report.txt', { type: 'text/plain' })
    sendMedia = [{ type: 'file', name: file.name, file, url: 'data:text/plain;base64,cmVwb3J0' }]
    apiMocks.uploadFile.mockRejectedValueOnce(new Error('Upload failed'))
    renderPane()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'submit draft' })) })
    expect(apiMocks.sendMessage).not.toHaveBeenCalled()
    expect(sendResult).toHaveBeenCalledWith(false)
    expect(liveSessionState.failSend).toHaveBeenCalledWith('Error: Upload failed')
  })

  it('does not report an accepted new session as failed when browser preference storage is full', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    const onSessionCreated = vi.fn()
    renderPane({ sessionId: null, onSessionCreated })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'submit draft' })) })
    expect(apiMocks.createSession).toHaveBeenCalledTimes(1)
    expect(onSessionCreated).toHaveBeenCalledWith('created-session', expect.objectContaining({ content: 'Draft message' }))
    expect(sendResult).toHaveBeenCalledWith(true)
    expect(liveSessionState.failSend).not.toHaveBeenCalled()
  })
})
