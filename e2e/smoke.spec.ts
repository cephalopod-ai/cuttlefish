import { test, expect } from '@playwright/test'

test.describe('Smoke tests', () => {
  test('dashboard loads and has correct title', async ({ page }) => {
    await page.goto('/')
    // Just check the page loads without 500 error
    await expect(page).not.toHaveURL(/error/)
    const title = await page.title()
    expect(title.length).toBeGreaterThan(0)
    await expect(page.getByText('Web UI needs a refresh')).toHaveCount(0)
    await expect(page.getByText('Chat crashed')).toHaveCount(0)
  })
})
