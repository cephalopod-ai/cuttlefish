import { useCallback, useEffect, useState } from 'react'
import { Folder, FolderOpen, ChevronUp, RotateCcw } from 'lucide-react'
import { api, type FsListResult } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

/**
 * Per-chat working-folder picker (new-chat only). `value` is the chosen absolute
 * dir, or null = default (CUTTLEFISH_HOME). Browses directories via /api/fs/list and
 * offers recent folders via /api/fs/recent. Selection is validated again server-
 * side at session create (validateCwd) — this is convenience, not the guard.
 */
export function FolderPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null
  onChange: (cwd: string | null) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<FsListResult | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  const [defaultDir, setDefaultDir] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const browse = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      setData(await api.fsList(path))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await api.fsRecent()
        if (cancelled) return
        setRecent(r.recent)
        setDefaultDir(r.default)
        await browse(value ?? r.default)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, value, browse])

  const label = value ? basename(value) : 'Default folder'

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={value ? `Working folder: ${value}` : 'Working folder: default (~/.cuttlefish)'}
        className="h-7 px-2 shrink-0 rounded-full flex items-center gap-1.5 bg-[var(--fill-tertiary)] border-none cursor-pointer text-[var(--text-secondary)] text-[11px] font-medium hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] transition-colors max-w-[160px]"
      >
        <Folder className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Working folder</DialogTitle>
            <DialogDescription>
              Pick the directory this chat&apos;s engine runs in. Defaults to the gateway home.
            </DialogDescription>
          </DialogHeader>

          {recent.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {recent.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => browse(r)}
                  title={r}
                  className="text-xs rounded-full border px-2 py-1 hover:bg-accent max-w-[200px] truncate"
                >
                  {basename(r)}
                </button>
              ))}
            </div>
          )}

          <div className="rounded-md border">
            <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-mono">
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate" title={data?.path}>{data?.path ?? '…'}</span>
              <div className="flex-1" />
              {data?.parent && (
                <button
                  type="button"
                  onClick={() => browse(data.parent!)}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent"
                  title="Up one level"
                >
                  <ChevronUp className="size-3.5" /> Up
                </button>
              )}
            </div>
            <div className="max-h-64 overflow-y-auto">
              {error ? (
                <div className="p-3 text-xs text-destructive">{error}</div>
              ) : loading ? (
                <div className="p-3 text-xs text-muted-foreground">Loading…</div>
              ) : data && data.entries.length === 0 ? (
                <div className="p-3 text-xs text-muted-foreground">No subfolders.</div>
              ) : (
                data?.entries.map((e) => (
                  <button
                    key={e.name}
                    type="button"
                    onClick={() => browse(`${data.path.replace(/\/$/, '')}/${e.name}`)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{e.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          <DialogFooter className="sm:justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
            >
              <RotateCcw className="size-3.5" /> Reset to default
            </Button>
            <Button
              size="sm"
              disabled={!data?.path || !!error}
              onClick={() => {
                if (data?.path) onChange(data.path)
                setOpen(false)
              }}
            >
              Use this folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
