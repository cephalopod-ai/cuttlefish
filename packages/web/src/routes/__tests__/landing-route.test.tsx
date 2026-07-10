import { describe, it, expect, vi } from 'vitest'
import { Suspense } from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const triageState = vi.hoisted(() => ({
  total: 0,
  isLoading: false,
}))

vi.mock('@/hooks/use-triage-summary', () => ({
  useTriageSummary: () => triageState,
}))

const settingsState = vi.hoisted(() => ({
  attentionAwareLanding: false,
}))

vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({ settings: settingsState }),
}))

vi.mock('../chat/page', () => ({
  default: () => <div>Chat page</div>,
}))

import LandingRoute from '../landing-route'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Suspense fallback={<div>Loading</div>}>
        <Routes>
          <Route path="/" element={<LandingRoute />} />
          <Route path="/command" element={<div>Command Center page</div>} />
        </Routes>
      </Suspense>
    </MemoryRouter>,
  )
}

describe('LandingRoute', () => {
  it('renders Chat when attention-aware landing is off', async () => {
    settingsState.attentionAwareLanding = false
    triageState.total = 3
    renderAt('/')
    expect(await screen.findByText('Chat page')).toBeTruthy()
  })

  it('renders Chat when attention-aware landing is on but nothing needs attention', async () => {
    settingsState.attentionAwareLanding = true
    triageState.total = 0
    renderAt('/')
    expect(await screen.findByText('Chat page')).toBeTruthy()
  })

  it('redirects to Command Center when attention-aware landing is on and triage has items', async () => {
    settingsState.attentionAwareLanding = true
    triageState.total = 2
    renderAt('/')
    expect(await screen.findByText('Command Center page')).toBeTruthy()
  })

  it('always renders Chat for a landing URL carrying a query string', async () => {
    settingsState.attentionAwareLanding = true
    triageState.total = 2
    renderAt('/?employee=boss')
    expect(await screen.findByText('Chat page')).toBeTruthy()
  })

  it('does not redirect while triage is still loading', async () => {
    settingsState.attentionAwareLanding = true
    triageState.total = 2
    triageState.isLoading = true
    try {
      renderAt('/')
      expect(await screen.findByText('Chat page')).toBeTruthy()
    } finally {
      triageState.isLoading = false
    }
  })
})
