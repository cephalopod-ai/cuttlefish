import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import type { Message } from '@/lib/conversations'

describe('ChatMessages tool groups', () => {
  it('renders unsafe markdown links as plain text', () => {
    const messages: Message[] = [{
      id: 'm1',
      role: 'assistant',
      content: 'Open [bad](javascript:alert(1)) and [good](https://example.com).',
      timestamp: 100,
    }]

    render(<ChatMessages messages={messages} loading={false} />)

    expect(screen.getByText(/bad/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull()
    expect(screen.getByRole('link', { name: 'good' }).getAttribute('href')).toBe('https://example.com')
  })

  it('keeps expanded tool rows compact and does not render block details', () => {
    const messages: Message[] = [
      {
        id: 'tool-edit',
        role: 'assistant',
        content: 'Used file_edit',
        timestamp: 100,
        toolCall: 'file_edit',
        blocks: [{
          id: 'plan-1',
          type: 'task-list',
          version: 1,
          title: 'Plan',
          payload: { items: [{ id: 'a', text: 'Hidden task detail', status: 'running' }] },
        }],
      },
      {
        id: 'tool-read',
        role: 'assistant',
        content: 'Used file_read',
        timestamp: 101,
        toolCall: 'file_read',
      },
      {
        id: 'answer',
        role: 'assistant',
        content: 'Done.',
        timestamp: 102,
      },
    ]

    render(<ChatMessages messages={messages} loading={false} />)

    const groupButton = screen.getByRole('button', { name: /2 tools/i })
    expect(groupButton.textContent).not.toMatch(/patch|detail/i)
    expect(screen.queryByText('Hidden task detail')).toBeNull()

    fireEvent.click(groupButton)
    const group = screen.getByTestId('tool-group-list')
    expect(within(group).getByText('file_edit')).toBeTruthy()
    expect(within(group).getByText('file_read')).toBeTruthy()
    expect(within(group).queryByText('Hidden task detail')).toBeNull()
    expect(within(group).queryByRole('button', { name: /file_edit/i })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Done.')).toBeTruthy()
  })

  it('only marks the latest unfinished active tool as running', () => {
    const messages: Message[] = [
      {
        id: 'tool-1',
        role: 'assistant',
        content: 'Using inspect_repo',
        timestamp: 100,
        toolCall: 'inspect_repo',
      },
      {
        id: 'tool-2',
        role: 'assistant',
        content: 'Using read_component',
        timestamp: 101,
        toolCall: 'read_component',
      },
      {
        id: 'tool-3',
        role: 'assistant',
        content: 'Using run_tests',
        timestamp: 102,
        toolCall: 'run_tests',
      },
    ]

    render(<ChatMessages messages={messages} loading />)

    fireEvent.click(screen.getByRole('button', { name: /3 tools running/i }))
    const group = screen.getByTestId('tool-group-list')

    expect(within(group).getAllByLabelText('Running')).toHaveLength(1)
    expect(within(group).getByText('run_tests').closest('div')?.textContent).toContain('run_tests')
  })

  it('keeps a tool group active when a live block follows it', () => {
    const messages: Message[] = [
      {
        id: 'tool-1',
        role: 'assistant',
        content: 'Using file_edit',
        timestamp: 100,
        toolCall: 'file_edit',
      },
      {
        id: 'plan',
        role: 'assistant',
        content: 'Plan',
        timestamp: 101,
        blocks: [{
          id: 'plan',
          type: 'task-list',
          version: 1,
          payload: { items: [{ id: 'a', text: 'Edit file', status: 'running' }] },
        }],
      },
    ]

    render(<ChatMessages messages={messages} loading />)

    fireEvent.click(screen.getByRole('button', { name: /1 tool running/i }))
    expect(within(screen.getByTestId('tool-group-list')).getAllByLabelText('Running')).toHaveLength(1)
  })

  it('keeps a hidden active tool visible in long running groups', () => {
    const messages: Message[] = Array.from({ length: 12 }, (_, index) => ({
      id: `tool-${index + 1}`,
      role: 'assistant' as const,
      content: index === 11 ? 'Using tool_12' : `Used tool_${index + 1}`,
      timestamp: 100 + index,
      toolCall: `tool_${index + 1}`,
    }))

    render(<ChatMessages messages={messages} loading />)

    fireEvent.click(screen.getByRole('button', { name: /12 tools running/i }))
    const group = screen.getByTestId('tool-group-list')

    expect(within(group).getByText('tool_12')).toBeTruthy()
    expect(within(group).getAllByLabelText('Running')).toHaveLength(1)
    expect(within(group).getByRole('button', { name: /show 2 more/i })).toBeTruthy()
  })

  it('caps long tool groups behind a compact more button', () => {
    const messages: Message[] = Array.from({ length: 12 }, (_, index) => ({
      id: `tool-${index + 1}`,
      role: 'assistant' as const,
      content: `Used tool_${index + 1}`,
      timestamp: 100 + index,
      toolCall: `tool_${index + 1}`,
    }))

    render(<ChatMessages messages={messages} loading={false} />)

    const groupButton = screen.getByRole('button', { name: /12 tools/i })
    expect(groupButton.textContent).not.toContain('tool_1')
    expect(groupButton.textContent).not.toContain('tool_2')

    fireEvent.click(groupButton)
    const group = screen.getByTestId('tool-group-list')

    expect(within(group).getByText('tool_1')).toBeTruthy()
    expect(within(group).getByText('tool_10')).toBeTruthy()
    expect(within(group).queryByText('tool_11')).toBeNull()
    expect(within(group).getByRole('button', { name: /show 2 more/i })).toBeTruthy()

    fireEvent.click(within(group).getByRole('button', { name: /show 2 more/i }))
    expect(within(group).getByText('tool_11')).toBeTruthy()
    expect(within(group).getByText('tool_12')).toBeTruthy()
    expect(within(group).queryByRole('button', { name: /show 2 more/i })).toBeNull()
  })
})
