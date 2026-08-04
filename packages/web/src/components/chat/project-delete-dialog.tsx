import { useEffect, useState } from "react"
import type { ProjectSummary } from "@cuttlefish/contracts"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function ProjectDeleteDialog({
  project,
  open,
  deleting,
  onOpenChange,
  onConfirm,
}: {
  project: ProjectSummary
  open: boolean
  deleting: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) setError(null)
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete project permanently?</DialogTitle>
          <DialogDescription>
            This permanently deletes “{project.title}” and all {project.sessionCount} sessions in its tree. It is unavailable while any member is active or awaiting action.
          </DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="text-xs text-[var(--system-red)]">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>No</Button>
          <Button
            variant="destructive"
            disabled={deleting}
            onClick={() => void onConfirm().catch((reason) => setError(reason instanceof Error ? reason.message : "Deletion failed"))}
          >
            {deleting ? "Deleting…" : "Yes, delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
