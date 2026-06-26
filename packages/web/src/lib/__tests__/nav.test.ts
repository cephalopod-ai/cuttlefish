import { describe, it, expect } from 'vitest'
import { NAV_ITEMS, MOBILE_TAB_ITEMS } from '../nav'

describe('MOBILE_TAB_ITEMS', () => {
  it('has exactly 5 curated entries', () => {
    expect(MOBILE_TAB_ITEMS).toHaveLength(5)
  })

  it('lists the curated hrefs in order', () => {
    expect(MOBILE_TAB_ITEMS.map((item) => item.href)).toEqual([
      '/',
      '/talk',
      '/org',
      '/cron',
      '/settings',
    ])
  })

  it('derives every entry from NAV_ITEMS (icons/labels stay in sync)', () => {
    for (const item of MOBILE_TAB_ITEMS) {
      expect(NAV_ITEMS).toContain(item)
    }
  })
})
