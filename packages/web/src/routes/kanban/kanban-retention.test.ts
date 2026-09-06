import { describe, expect, it } from 'vitest'
import { clampRecycleBinRetentionDays, formatRecycleBinDays, formatDeletedAt, formatDeletionExpiry, DAY_MS } from './kanban-retention'

describe('recycle-bin retention helpers', () => {
  it('clamps the server-compatible retention range and defaults invalid input', () => {
    expect([-1, 0, 2.6, 7, 8, NaN, Infinity, undefined].map(clampRecycleBinRetentionDays))
      .toEqual([0, 0, 3, 7, 7, 3, 3, 3])
  })

  it('formats immediate purge, singular and plural retention', () => {
    expect([0, 1, 3].map(formatRecycleBinDays)).toEqual(['Immediate purge', '1 day', '3 days'])
  })

  it('formats deletion and expiry using the supplied timestamp and retention', () => {
    const deletedAt = Date.parse('2026-09-06T10:00:00Z')
    expect(formatDeletedAt(deletedAt)).toBe(new Date(deletedAt).toLocaleString())
    expect(formatDeletionExpiry(deletedAt, 0)).toBe('immediately')
    expect(formatDeletionExpiry(deletedAt, 2)).toBe(new Date(deletedAt + 2 * DAY_MS).toLocaleString())
  })
})

it('defaults malformed JSON retention objects without aborting the board load', () => {
  expect(clampRecycleBinRetentionDays({ valueOf: null, toString: null })).toBe(3)
})
