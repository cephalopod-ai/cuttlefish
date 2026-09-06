/**
 * Recycle-bin retention values and display formatting.
 * Extracted from routes/kanban/page.tsx in a behavior-preserving modularization.
 * These originally private helpers are not re-exported by the page facade.
 */
import type { KanbanTicket } from '@/lib/kanban/types'

export const DEFAULT_RECYCLE_BIN_RETENTION_DAYS = 3
export const MIN_RECYCLE_BIN_RETENTION_DAYS = 0
export const MAX_RECYCLE_BIN_RETENTION_DAYS = 7
export const DAY_MS = 24 * 60 * 60 * 1000

export type DeletedKanbanTicket = KanbanTicket & { deletedAt: number }

export function clampRecycleBinRetentionDays(value: unknown): number {
  let n: number
  try {
    n = typeof value === 'number' ? value : Number(value)
  } catch {
    return DEFAULT_RECYCLE_BIN_RETENTION_DAYS
  }
  if (!Number.isFinite(n)) return DEFAULT_RECYCLE_BIN_RETENTION_DAYS
  return Math.max(MIN_RECYCLE_BIN_RETENTION_DAYS, Math.min(MAX_RECYCLE_BIN_RETENTION_DAYS, Math.round(n)))
}

export function formatRecycleBinDays(days: number): string {
  if (days === 0) return 'Immediate purge'
  return `${days} day${days === 1 ? '' : 's'}`
}

export function formatDeletedAt(ts: number): string {
  return new Date(ts).toLocaleString()
}

export function formatDeletionExpiry(ts: number, retentionDays: number): string {
  if (retentionDays <= 0) return 'immediately'
  return new Date(ts + (retentionDays * DAY_MS)).toLocaleString()
}
