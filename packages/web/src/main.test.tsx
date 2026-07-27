import { render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render: vi.fn() }),
}))

vi.mock('./routes/client-providers', () => ({
  ClientProviders: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('./routes/landing-route', () => ({
  default: () => <div>Chat page</div>,
}))

let App: typeof import('./main').App

describe('App routes', () => {
  beforeAll(async () => {
    document.body.innerHTML = '<div id="root"></div>'
    ;({ App } = await import('./main'))
  })

  afterEach(() => window.history.replaceState({}, '', '/'))

  // DESIGN-007: an unknown route used to silently redirect home instead of
  // rendering a blank shell — which looked identical to a normal visit, so a
  // broken/stale link gave no indication anything was wrong. It now renders
  // a dedicated 404 with a way back home, rather than either extreme.
  it('renders a 404 for an unknown route instead of a blank shell or a silent redirect', async () => {
    window.history.replaceState({}, '', '/nonsense-route-xyz')
    render(<App />)

    expect(await screen.findByText('Page not found')).toBeTruthy()
    expect(window.location.pathname).toBe('/nonsense-route-xyz')
  })

  it('redirects stale Talk links into the Team collaboration lane', async () => {
    window.history.replaceState({}, '', '/talk')
    render(<App />)
    expect(await screen.findByText('Chat page')).toBeTruthy()
    expect(`${window.location.pathname}${window.location.search}`).toBe('/?lane=team')
  })
})
