import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'

vi.mock('@/components/page-layout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/context/breadcrumb-context', () => ({
  useBreadcrumbs: () => undefined,
}))

const commandCenterState = vi.hoisted(() => ({
  data: {
    generatedAt: '2026-07-01T00:00:00Z',
    summary: { agents: 5, agentsRunning: 2, cronJobs: 3, ticketsTotal: 9 },
    ticketCounts: { todo: 4, blocked: 1, done: 4 },
    managers: [{ employee: 'boss', displayName: 'Boss', department: 'engineering', rank: 'manager', running: true }],
    availableAgents: [{
      employee: 'boss',
      displayName: 'Boss',
      rank: 'manager',
      department: 'engineering',
      engine: 'claude',
      model: 'sonnet',
      running: true,
      usage: {
        day: { range: 'day', sessionCount: 2, totalCostUsd: 1.5, totalTurns: 3, totalTokens: 1200 },
        week: { range: 'week', sessionCount: 3, totalCostUsd: 2, totalTurns: 5, totalTokens: 1800 },
        month: { range: 'month', sessionCount: 4, totalCostUsd: 3, totalTurns: 8, totalTokens: 2400 },
      },
    }],
  },
  isLoading: false,
  error: null as Error | null,
}))

vi.mock('@/hooks/use-command-center', () => ({
  useCommandCenter: () => commandCenterState,
}))

import CommandPage from './page'

describe('CommandPage', () => {
  it('renders the redesigned dashboard shell, manager chat link, and agent usage', () => {
    render(
      <MemoryRouter>
        <CommandPage />
      </MemoryRouter>,
    )

    expect(screen.getByText('Command Center')).toBeTruthy()
    expect(screen.getByText(/blocked ticket need attention/i)).toBeTruthy()
    expect(screen.getByText(/fleet status, manager routing, and usage rollups/i)).toBeTruthy()
    expect((screen.getByRole('link', { name: /Start chat with Boss/i }) as HTMLAnchorElement).getAttribute('href')).toBe('/?employee=boss')
    expect(screen.getByText(/claude · sonnet · 3 turns · \$1\.50/i)).toBeTruthy()
    expect(screen.getByText('Open tickets')).toBeTruthy()
  })
})
