import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChatBlockInline } from '../chat-blocks'
import type { ChatBlock } from '@/lib/blocks'

describe('ChatBlockInline', () => {
  it('renders a task-list block with status rows', () => {
    const block: ChatBlock = {
      id: 'plan',
      type: 'task-list',
      version: 1,
      title: 'Plan',
      status: 'running',
      payload: {
        items: [
          { id: 'a', text: 'Read code', status: 'done' },
          { id: 'b', text: 'Patch UI', status: 'running' },
        ],
      },
    }
    render(<ChatBlockInline block={block} />)
    expect(screen.getByText('Plan')).toBeTruthy()
    expect(screen.getByText('Read code')).toBeTruthy()
    expect(screen.getByText('Patch UI')).toBeTruthy()
  })
})
