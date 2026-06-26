import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Archive, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useCreateArchive } from '@/hooks/use-archives'
import type { ArchiveKind } from '@/lib/api'
import type { Session } from './sidebar-types'

export interface ArchiveDialogTarget {
  kind: ArchiveKind
  title: string
  sessionIds: string[]
  sourceRef?: string
  sessions: Pick<Session, 'id' | 'status' | 'transportState'>[]
}

interface ArchiveDialogProps {
  target: ArchiveDialogTarget | null
  onOpenChange: (open: boolean) => void
  onArchived?: (sessionIds: string[]) => void
}

const kindLabel: Record<ArchiveKind, string> = {
  room: 'room',
  scheduled: 'scheduled runs',
  chat: 'chat',
}

export function ArchiveDialog({ target, onOpenChange, onArchived }: ArchiveDialogProps) {
  const createArchive = useCreateArchive()
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const open = !!target

  useEffect(() => {
    if (!target) {
      setLabel('')
      setNote('')
    }
  }, [target])

  const runningCount = useMemo(() => {
    return target?.sessions.filter((session) => (
      session.status === 'running' || session.transportState === 'running'
    )).length ?? 0
  }, [target])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!target || createArchive.isPending) return
    const sessionIds = target.sessionIds
    await createArchive.mutateAsync({
      kind: target.kind,
      sessionIds,
      sourceRef: target.sourceRef,
      label: label.trim() || undefined,
      note: note.trim() || undefined,
    })
    onArchived?.(sessionIds)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Archive />
              Archive {target ? kindLabel[target.kind] : 'project'}
            </DialogTitle>
            <DialogDescription>
              {target
                ? `${target.sessionIds.length} ${target.sessionIds.length === 1 ? 'chat' : 'chats'} will be filed as a dated Previous Project and removed from the sidebar.`
                : 'Archive selected chats.'}
            </DialogDescription>
          </DialogHeader>

          {target ? (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="font-medium text-foreground">{target.title}</div>
              <div className="text-xs text-muted-foreground">
                {target.sessionIds.length} {target.sessionIds.length === 1 ? 'chat' : 'chats'}
              </div>
            </div>
          ) : null}

          {runningCount > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5" />
              <span>
                {runningCount} selected {runningCount === 1 ? 'chat is' : 'chats are'} currently running.
              </span>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <label htmlFor="archive-label" className="text-sm font-medium">Label</label>
            <Input
              id="archive-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={200}
              placeholder="Optional project label"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="archive-note" className="text-sm font-medium">Note</label>
            <Textarea
              id="archive-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={5000}
              rows={4}
              placeholder="Optional note"
            />
          </div>

          {createArchive.error ? (
            <div className="text-sm text-destructive">{(createArchive.error as Error).message}</div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={createArchive.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!target || createArchive.isPending}>
              <Archive />
              {createArchive.isPending ? 'Archiving...' : 'Archive'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
