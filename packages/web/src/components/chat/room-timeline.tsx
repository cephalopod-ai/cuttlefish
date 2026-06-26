/**
 * RoomTimeline — the merged, read-only multi-agent view for one department room.
 *
 * Given a `DepartmentRoom` (computed by the pure `lib/rooms` layer) it renders a
 * single chronological feed of every agent's contribution in that department,
 * each labeled with speaker + intended `@target` + timestamp, with a provenance
 * link back to the source session's live chat. Live back-and-forth still happens
 * in that per-session `ChatPane` (this surface is intentionally read-only —
 * "open ▸" jumps there). Rendering is data-driven via a reusable card; nothing
 * is hardcoded per agent.
 */

import { useMemo } from 'react'
import { ArrowUpRight, Hash, Users } from 'lucide-react'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { cn } from '@/lib/utils'
import { buildRoomTimeline } from '@/lib/rooms/grouping'
import type {
  DepartmentRoom,
  RoomEmployee,
  RoomSession,
  RoomTarget,
  RoomTimelineEntry,
} from '@/lib/rooms/types'

const MAX_HEADER_AVATARS = 6

function formatWhen(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  if (d.toDateString() === now.toDateString()) return time
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${date} ${time}`
}

/** `@target` chip — neutral for @all, accented when addressed to a specific agent. */
function TargetChip({ target }: { target: RoomTarget }) {
  const specific = target.kind !== 'all'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[var(--radius-sm)] px-1.5 py-px text-[length:var(--text-caption2)] font-[var(--weight-medium)]',
        specific
          ? 'bg-[var(--accent-fill)] text-[var(--accent)]'
          : 'bg-[var(--fill-tertiary)] text-[var(--text-tertiary)]',
      )}
      title={`Addressed to ${target.label}`}
    >
      @{target.label}
    </span>
  )
}

interface RoomMessageCardProps {
  entry: RoomTimelineEntry
  onOpen: () => void
}

/** One contribution row. The whole row is a single button (keyboard-accessible,
 *  no nested interactive children) that opens the source session. */
function RoomMessageCard({ entry, onOpen }: RoomMessageCardProps) {
  const running = entry.status === 'running' || entry.status === 'waiting'
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${entry.speakerName}'s session`}
      className={cn(
        'group flex w-full items-start gap-[var(--space-3)] rounded-[var(--radius-md)] px-[var(--space-3)] py-[var(--space-3)] text-left',
        'hover:bg-[var(--fill-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]',
      )}
    >
      <EmployeeAvatar name={entry.speakerKey || entry.speakerName} size={32} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-0.5">
          <span className="font-[var(--weight-semibold)] text-[var(--text-primary)] text-[length:var(--text-subheadline)]">
            {entry.speakerName}
          </span>
          <TargetChip target={entry.target} />
          {running && (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] animate-pulse"
              aria-label="running"
            />
          )}
          <span className="ml-auto shrink-0 text-[length:var(--text-caption2)] text-[var(--text-tertiary)] tabular-nums">
            {formatWhen(entry.createdAt)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[length:var(--text-body)] text-[var(--text-secondary)]">
          {entry.headline}
        </span>
        {entry.ask && (
          <span className="mt-px block truncate text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            asked: {entry.ask}
          </span>
        )}
      </span>
      <ArrowUpRight
        size={15}
        className="mt-0.5 shrink-0 text-[var(--text-quaternary)] opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden
      />
    </button>
  )
}

interface RoomTimelineProps {
  room: DepartmentRoom
  employees: RoomEmployee[]
  /** Full loaded session set, so child entries resolve their parent `@target`. */
  sessionsById?: Map<string, RoomSession>
  onOpenSession: (sessionId: string) => void
  className?: string
}

export function RoomTimeline({
  room,
  employees,
  sessionsById,
  onOpenSession,
  className,
}: RoomTimelineProps) {
  const entries = useMemo(
    () => buildRoomTimeline(room, employees, sessionsById),
    [room, employees, sessionsById],
  )

  const headerAvatars = room.participants.slice(0, MAX_HEADER_AVATARS)
  const overflow = room.participants.length - headerAvatars.length

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)} data-testid="room-timeline">
      {/* Header */}
      <header className="shrink-0 border-b border-[var(--separator)] px-[var(--space-4)] py-[var(--space-3)]">
        <div className="flex items-center gap-[var(--space-2)]">
          <Hash size={16} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
          <h2 className="truncate font-[var(--weight-semibold)] text-[var(--text-primary)] text-[length:var(--text-title3)]">
            {room.name}
          </h2>
          {room.status === 'active' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-fill)] px-2 py-px text-[length:var(--text-caption2)] font-[var(--weight-medium)] text-[var(--accent)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
              active
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          <span className="inline-flex items-center gap-1">
            <Users size={12} aria-hidden />
            {room.participantCount} {room.participantCount === 1 ? 'agent' : 'agents'}
          </span>
          <span aria-hidden>·</span>
          <span>
            {room.sessionCount} {room.sessionCount === 1 ? 'chat' : 'chats'}
          </span>
          {room.lastActivity && (
            <>
              <span aria-hidden>·</span>
              <span>last active {formatWhen(room.lastActivity)}</span>
            </>
          )}
        </div>
        {headerAvatars.length > 0 && (
          <div className="mt-2 flex items-center">
            {headerAvatars.map((p) => (
              <span
                key={p.name || p.displayName}
                title={`${p.displayName} · ${p.sessionCount} ${p.sessionCount === 1 ? 'chat' : 'chats'}`}
                className="-mr-1.5 rounded-full ring-2 ring-[var(--bg)]"
              >
                <EmployeeAvatar name={p.name || p.displayName} size={22} />
              </span>
            ))}
            {overflow > 0 && (
              <span className="ml-[var(--space-2)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                +{overflow}
              </span>
            )}
          </div>
        )}
      </header>

      {/* Read-only hint */}
      <p className="shrink-0 px-[var(--space-4)] pt-[var(--space-2)] text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
        Combined activity across this department · read-only — open an agent to reply.
      </p>

      {/* Timeline */}
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--space-2)] py-[var(--space-2)]">
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-[var(--space-6)] text-center">
            <p className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
              No activity in this room yet
            </p>
            <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              Conversations from this department's agents will appear here.
            </p>
          </div>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {entries.map((entry) => (
              <li key={entry.id}>
                <RoomMessageCard entry={entry} onOpen={() => onOpenSession(entry.sourceSessionId)} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}
