import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { MessageSquarePlus, Users, PlayCircle, Ticket, Clock3 } from 'lucide-react'
import { PageLayout } from '@/components/page-layout'
import { Skeleton } from '@/components/ui/skeleton'
import { useBreadcrumbs } from '@/context/breadcrumb-context'
import { useCommandCenter } from '@/hooks/use-command-center'
import type { CommandCenterUsageRange } from '@/lib/api'

const RANGE_OPTIONS: CommandCenterUsageRange[] = ['day', 'week', 'month']

function MetricCard({
  title,
  value,
  href,
  icon,
}: {
  title: string
  value: number
  href: string
  icon: React.ReactNode
}) {
  return (
    <Link
      to={href}
      className="rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--material-regular)] p-4 transition-colors hover:border-[var(--accent)] hover:bg-[var(--fill-secondary)]"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">{title}</span>
        <span className="text-[var(--accent)]">{icon}</span>
      </div>
      <div className="text-3xl font-semibold text-[var(--text-primary)]">{value}</div>
    </Link>
  )
}

function prettifyTicketStatus(status: string): string {
  return status.replace(/_/g, ' ')
}

export default function CommandPage() {
  useBreadcrumbs([{ label: 'Command Center' }])
  const { data, isLoading, error } = useCommandCenter()
  const [range, setRange] = useState<CommandCenterUsageRange>('day')

  const ticketEntries = useMemo(
    () => Object.entries(data?.ticketCounts ?? {}).sort((a, b) => b[1] - a[1]),
    [data?.ticketCounts],
  )

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto bg-[var(--bg)]">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 p-4 sm:p-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-[length:var(--text-title2)] font-semibold text-[var(--text-primary)]">Command Center</h1>
            <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
              Operational counts, manager contact shortcuts, and agent usage rollups.
            </p>
          </div>

          {error && (
            <div className="rounded-[var(--radius-lg)] border border-[var(--system-red)] px-4 py-3 text-[var(--system-red)]">
              {error instanceof Error ? error.message : 'Failed to load command center'}
            </div>
          )}

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-32 rounded-[var(--radius-lg)]" />)
            ) : (
              <>
                <MetricCard title="Agents" value={data?.summary.agents ?? 0} href="/org" icon={<Users size={18} />} />
                <MetricCard title="Agents running" value={data?.summary.agentsRunning ?? 0} href="/org" icon={<PlayCircle size={18} />} />
                <MetricCard title="Tickets" value={data?.summary.ticketsTotal ?? 0} href="/kanban" icon={<Ticket size={18} />} />
                <MetricCard title="Cron jobs" value={data?.summary.cronJobs ?? 0} href="/cron" icon={<Clock3 size={18} />} />
              </>
            )}
          </section>

          <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <section className="rounded-[var(--radius-xl)] border border-[var(--separator)] bg-[var(--material-regular)] p-4 sm:p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[length:var(--text-headline)] font-semibold text-[var(--text-primary)]">Available agents</h2>
                  <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                    Usage rollup by observed session token volume and cost.
                  </p>
                </div>
                <div className="flex rounded-full border border-[var(--separator)] bg-[var(--bg-secondary)] p-1">
                  {RANGE_OPTIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setRange(option)}
                      className={[
                        'rounded-full px-3 py-1 text-[length:var(--text-caption1)] capitalize transition-colors',
                        option === range
                          ? 'bg-[var(--accent)] text-white'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                      ].join(' ')}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-3">
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-24 rounded-[var(--radius-lg)]" />)
                ) : (
                  data?.availableAgents.map((agent) => {
                    const usage = agent.usage[range]
                    return (
                      <div key={agent.employee} className="rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--bg)] p-4">
                        <div className="mb-2 flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium text-[var(--text-primary)]">{agent.displayName}</div>
                            <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                              @{agent.employee} · {agent.rank} · {agent.department ?? 'unassigned'}
                            </div>
                          </div>
                          <div className="text-right text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
                            <div>{agent.engine}</div>
                            <div>{agent.model}</div>
                          </div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-4 text-[length:var(--text-caption1)]">
                          <div>
                            <div className="text-[var(--text-tertiary)]">Sessions</div>
                            <div className="font-medium text-[var(--text-primary)]">{usage.sessionCount}</div>
                          </div>
                          <div>
                            <div className="text-[var(--text-tertiary)]">Tokens</div>
                            <div className="font-medium text-[var(--text-primary)]">{usage.totalTokens.toLocaleString()}</div>
                          </div>
                          <div>
                            <div className="text-[var(--text-tertiary)]">Turns</div>
                            <div className="font-medium text-[var(--text-primary)]">{usage.totalTurns.toLocaleString()}</div>
                          </div>
                          <div>
                            <div className="text-[var(--text-tertiary)]">Cost</div>
                            <div className="font-medium text-[var(--text-primary)]">${usage.totalCostUsd.toFixed(2)}</div>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </section>

            <div className="grid gap-6">
              <section className="rounded-[var(--radius-xl)] border border-[var(--separator)] bg-[var(--material-regular)] p-4 sm:p-5">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-[length:var(--text-headline)] font-semibold text-[var(--text-primary)]">Managers</h2>
                    <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                      Start a direct chat using existing employee routing.
                    </p>
                  </div>
                  <Link to="/org" className="text-[length:var(--text-caption1)] text-[var(--accent)] hover:underline">Open org</Link>
                </div>
                <div className="grid gap-3">
                  {isLoading ? (
                    Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-20 rounded-[var(--radius-lg)]" />)
                  ) : (
                    data?.managers.map((manager) => (
                      <div key={manager.employee} className="flex items-center justify-between rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--bg)] px-4 py-3">
                        <div>
                          <div className="font-medium text-[var(--text-primary)]">{manager.displayName}</div>
                          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                            @{manager.employee} · {manager.rank} · {manager.department ?? 'unassigned'}
                          </div>
                        </div>
                        <Link
                          to={`/?employee=${encodeURIComponent(manager.employee)}`}
                          aria-label={`Start chat with ${manager.displayName}`}
                          className="rounded-full border border-[var(--separator)] p-2 text-[var(--accent)] transition-colors hover:bg-[var(--fill-secondary)]"
                        >
                          <MessageSquarePlus size={18} />
                        </Link>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="rounded-[var(--radius-xl)] border border-[var(--separator)] bg-[var(--material-regular)] p-4 sm:p-5">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-[length:var(--text-headline)] font-semibold text-[var(--text-primary)]">Tickets by status</h2>
                    <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                      Count-only view with links back to the board.
                    </p>
                  </div>
                  <Link to="/kanban" className="text-[length:var(--text-caption1)] text-[var(--accent)] hover:underline">Open board</Link>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {isLoading ? (
                    Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-16 rounded-[var(--radius-lg)]" />)
                  ) : (
                    ticketEntries.map(([status, count]) => (
                      <Link
                        key={status}
                        to="/kanban"
                        className="rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--bg)] px-4 py-3 transition-colors hover:border-[var(--accent)]"
                      >
                        <div className="text-[length:var(--text-caption1)] capitalize text-[var(--text-tertiary)]">{prettifyTicketStatus(status)}</div>
                        <div className="text-2xl font-semibold text-[var(--text-primary)]">{count}</div>
                      </Link>
                    ))
                  )}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
