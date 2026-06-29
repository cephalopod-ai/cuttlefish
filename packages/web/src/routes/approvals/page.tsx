import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Check, X, ShieldQuestion, ArrowRight, PauseCircle, FileText, FolderArchive, Wrench } from 'lucide-react'
import { PageLayout } from '@/components/page-layout'
import { useBreadcrumbs } from '@/context/breadcrumb-context'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useApprovals, useApproveApproval, useRejectApproval } from '@/hooks/use-approvals'
import { useCheckpoints, useDecideCheckpoint } from '@/hooks/use-checkpoints'
import type { Approval, ApprovalDecision, Checkpoint } from '@/lib/api'

function fallbackSummary(payload: Record<string, unknown>): { from: string; to: string; reason?: string } {
  const from = payload.from as { engine?: string; model?: string } | undefined
  const to = payload.to as { engine?: string; model?: string } | undefined
  const fmt = (e?: { engine?: string; model?: string }) =>
    e ? `${e.engine ?? '?'}${e.model ? `/${e.model}` : ''}` : '?'
  return { from: fmt(from), to: fmt(to), reason: typeof payload.reason === 'string' ? payload.reason : undefined }
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const approve = useApproveApproval()
  const reject = useRejectApproval()
  const busy = approve.isPending || reject.isPending
  const { from, to, reason } = fallbackSummary(approval.payload)

  return (
    <div className="rounded-lg border bg-card p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        <ShieldQuestion className="size-4 text-amber-500" />
        <span className="font-medium capitalize">{approval.type} approval</span>
        {reason && (
          <span className="text-xs rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{reason}</span>
        )}
      </div>

      {approval.type === 'fallback' && (
        <div className="flex items-center gap-2 text-sm font-mono">
          <span className="text-muted-foreground">{from}</span>
          <ArrowRight className="size-3.5" />
          <span className="text-foreground">{to}</span>
        </div>
      )}

      <div className="text-xs text-muted-foreground">
        Session{' '}
        <Link to={`/?session=${approval.sessionId}`} className="underline hover:text-foreground">
          {approval.sessionId.slice(0, 8)}
        </Link>{' '}
        · {new Date(approval.createdAt).toLocaleString()}
      </div>

      {(approve.error || reject.error) && (
        <div className="text-xs text-destructive">
          {(approve.error as Error)?.message || (reject.error as Error)?.message}
        </div>
      )}

      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => approve.mutate(approval.id)}>
          <Check className="size-3.5" /> Approve &amp; resume
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate(approval.id)}>
          <X className="size-3.5" /> Reject
        </Button>
      </div>
    </div>
  )
}

function CheckpointList({
  icon,
  label,
  items,
}: {
  icon: ReactNode
  label: string
  items?: string[]
}) {
  if (!items || items.length === 0) return null
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
      <div className="mb-2 flex items-center gap-2 font-medium text-foreground">
        {icon}
        {label}
      </div>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item} className="break-words">{item}</li>
        ))}
      </ul>
    </div>
  )
}

function CheckpointCard({ checkpoint }: { checkpoint: Checkpoint }) {
  const decide = useDecideCheckpoint()
  const [revisionNotes, setRevisionNotes] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const busy = decide.isPending
  const options = checkpoint.payload.options ?? ['approved', 'rejected', 'deferred', 'revised']

  async function submit(decision: ApprovalDecision) {
    setLocalError(null)
    const trimmed = revisionNotes.trim()
    if (decision === 'revised' && trimmed.length === 0) {
      setLocalError('Revision notes are required to revise and resume.')
      return
    }
    await decide.mutateAsync({
      id: checkpoint.id,
      body: {
        decision,
        notes: trimmed || undefined,
        resumePrompt: decision === 'revised' ? trimmed : undefined,
      },
    })
  }

  return (
    <div className="rounded-lg border bg-card p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        <PauseCircle className="size-4 text-amber-500" />
        <span className="font-medium">Human checkpoint</span>
      </div>

      <div className="space-y-1">
        <div className="text-sm font-medium text-foreground">{checkpoint.payload.decisionNeeded}</div>
        <div className="text-sm text-muted-foreground">{checkpoint.payload.why}</div>
      </div>

      <div className="text-xs text-muted-foreground">
        Session{' '}
        <Link to={`/?session=${checkpoint.sessionId}`} className="underline hover:text-foreground">
          {checkpoint.sessionId.slice(0, 8)}
        </Link>{' '}
        · {new Date(checkpoint.createdAt).toLocaleString()}
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        <CheckpointList icon={<FileText className="size-3.5" />} label="Files" items={checkpoint.payload.affectedFiles} />
        <CheckpointList icon={<FolderArchive className="size-3.5" />} label="Artifacts" items={checkpoint.payload.affectedArtifacts} />
        <CheckpointList icon={<Wrench className="size-3.5" />} label="Actions" items={checkpoint.payload.affectedActions} />
      </div>

      {options.includes('revised') ? (
        <div className="space-y-2">
          <label className="text-xs font-medium text-foreground">Revision notes</label>
          <Textarea
            rows={3}
            value={revisionNotes}
            onChange={(e) => setRevisionNotes(e.target.value)}
            placeholder="Tell the agent what to change before continuing."
          />
        </div>
      ) : null}

      {(localError || decide.error) && (
        <div className="text-xs text-destructive">
          {localError || (decide.error as Error)?.message}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {options.includes('approved') ? (
          <Button size="sm" disabled={busy} onClick={() => void submit('approved')}>
            <Check className="size-3.5" /> Approve
          </Button>
        ) : null}
        {options.includes('revised') ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void submit('revised')}>
            <FileText className="size-3.5" /> Revise &amp; resume
          </Button>
        ) : null}
        {options.includes('deferred') ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit('deferred')}>
            Defer
          </Button>
        ) : null}
        {options.includes('rejected') ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit('rejected')}>
            <X className="size-3.5" /> Reject
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export default function ApprovalsPage() {
  useBreadcrumbs([{ label: 'Approvals' }])
  const {
    data: approvals,
    isLoading: approvalsLoading,
    error: approvalsError,
  } = useApprovals('pending')
  const {
    data: checkpoints,
    isLoading: checkpointsLoading,
    error: checkpointsError,
  } = useCheckpoints('pending')
  const isLoading = approvalsLoading || checkpointsLoading
  const hasItems = (approvals?.length ?? 0) > 0 || (checkpoints?.length ?? 0) > 0

  return (
    <PageLayout>
      <div className="h-full min-h-0">
        <div
          data-scrollable
          data-testid="approvals-scroll-region"
          className="mx-auto flex h-full w-full max-w-2xl min-h-0 flex-col gap-4 overflow-y-auto p-4 sm:p-6"
        >
          <div>
            <h1 className="text-lg font-semibold">Approvals</h1>
            <p className="text-sm text-muted-foreground">
              Sessions waiting on a human decision (e.g. a model fallback after a rate limit). Approving
              resumes the session on the fallback engine; rejecting stops it — surfaced, not silently stalled.
            </p>
          </div>

          {isLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          ) : (approvalsError || checkpointsError) ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              {approvalsError instanceof Error ? approvalsError.message : checkpointsError instanceof Error ? checkpointsError.message : 'Failed to load approvals.'}
            </div>
          ) : !hasItems ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No pending approvals.
            </div>
          ) : (
            <div className="flex flex-col gap-3 pb-2">
              {approvals && approvals.length > 0 ? (
                <>
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <ShieldQuestion className="size-3.5" />
                    Fallback approvals
                  </div>
                  {approvals.map((approval) => (
                    <ApprovalCard key={approval.id} approval={approval} />
                  ))}
                </>
              ) : null}
              {checkpoints && checkpoints.length > 0 ? (
                <>
                  <div className="flex items-center gap-2 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <PauseCircle className="size-3.5" />
                    Human checkpoints
                  </div>
                  {checkpoints.map((checkpoint) => (
                    <CheckpointCard key={checkpoint.id} checkpoint={checkpoint} />
                  ))}
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  )
}
