import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import NotFoundRoute from '../not-found-route'

// DESIGN-007: unknown paths used to silently redirect to "/" instead of
// telling the user the URL was wrong.
describe('NotFoundRoute', () => {
  it('renders a not-found message with a way back home', () => {
    render(
      <MemoryRouter>
        <NotFoundRoute />
      </MemoryRouter>,
    )
    expect(screen.getByText('Page not found')).toBeTruthy()
    const homeLink = screen.getByRole('link', { name: 'Go home' })
    expect(homeLink.getAttribute('href')).toBe('/')
  })
})
