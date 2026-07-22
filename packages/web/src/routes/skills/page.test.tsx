import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/components/page-layout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/context/breadcrumb-context', () => ({
  useBreadcrumbs: () => undefined,
}))

vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({ settings: { portalName: 'Cuttlefish' } }),
}))

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}))

const apiState = vi.hoisted(() => ({
  getSkills: vi.fn(async () => [{ name: 'audit', description: 'Audit a repo' }]),
  getSkill: vi.fn(async () => ({ content: '# Audit skill' })),
}))

vi.mock('@/lib/api', () => ({
  api: apiState,
}))

import SkillsPage from './page'

describe('SkillsPage', () => {
  it('opens a skill card with keyboard activation', async () => {
    render(<SkillsPage />)

    const card = await screen.findByRole('button', { name: /open skill audit/i })
    fireEvent.keyDown(card, { key: 'Enter' })

    await waitFor(() => expect(apiState.getSkill).toHaveBeenCalledWith('audit'))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})
