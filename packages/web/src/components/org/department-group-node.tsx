import { type NodeProps } from "@xyflow/react"
import { useEffect, useRef, useState } from "react"
import { Pencil } from "lucide-react"
import { deptHue } from "@/components/org/layout/dept-color"

export interface DepartmentGroupNodeData extends Record<string, unknown> {
  label: string
  /** False for the synthetic "Unassigned" block, which has no directory to rename. */
  renamable?: boolean
  /** Provided by OrgMap when the page can perform a rename. Rejects with a
   *  message the header renders in place. */
  onRename?: (nextName: string) => Promise<void>
}

/**
 * A department's bounding box on the org map, and the one place its name can be
 * edited. The rename lives here — on the label the operator is actually looking
 * at — rather than only in the filter row, where it was previously invisible
 * until a department tab was selected.
 */
export function DepartmentGroupNode({ data }: NodeProps) {
  const { label, renamable, onRename } = data as DepartmentGroupNodeData
  const hue = deptHue(label)
  const canRename = renamable !== false && typeof onRename === "function"

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  function startEditing() {
    setDraft(label)
    setError(null)
    setEditing(true)
  }

  function cancelEditing() {
    setEditing(false)
    setError(null)
  }

  async function commit() {
    if (!onRename || saving) return
    const nextName = draft.trim()
    if (!nextName || nextName === label) {
      cancelEditing()
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onRename(nextName)
      // The rename changes this node's id, so this component unmounts on the
      // next layout; clearing the flag keeps the state honest if it does not.
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="w-full h-full relative rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] overflow-hidden"
      style={{ border: "1px solid var(--separator)", ["--dept-h" as string]: String(hue) }}
    >
      {/* Subtle per-department hue: left stripe only (amber stays for selection) */}
      <span
        aria-hidden
        className="org-dept-accent absolute left-0 top-0 bottom-0 w-[3px] opacity-70"
      />
      {/* `group` drives the hover reveal of the pencil; the row itself stays
          click-through so dragging the canvas across a department still pans. */}
      <div className="group absolute top-[10px] left-0 right-0 flex flex-col items-center gap-[4px] select-none pointer-events-none">
        <div className="flex items-center justify-center gap-[6px]">
          <span className="org-dept-accent w-[6px] h-[6px] rounded-full" />
          {editing ? (
            <input
              ref={inputRef}
              // nodrag/nopan: React Flow otherwise treats a drag inside the
              // field as a canvas pan and text selection never starts.
              className="nodrag nopan pointer-events-auto h-[20px] w-[160px] rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--material-thick)] px-[6px] text-[length:var(--text-caption2)] font-[var(--weight-semibold)] tracking-[var(--tracking-wide)] uppercase text-[var(--text-primary)] outline-none disabled:opacity-60"
              value={draft}
              aria-label={`Rename ${label} department`}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === "Enter") void commit()
                if (event.key === "Escape") cancelEditing()
              }}
              onBlur={() => { if (!saving) cancelEditing() }}
            />
          ) : (
            <span className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] tracking-[var(--tracking-wide)] uppercase text-[var(--text-tertiary)]">
              {label}
            </span>
          )}
          {canRename && !editing && (
            <button
              type="button"
              aria-label={`Rename ${label} department`}
              title={`Rename ${label}`}
              className="nodrag nopan pointer-events-auto flex h-[16px] w-[16px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-tertiary)] opacity-0 transition-opacity hover:text-[var(--accent)] focus-visible:opacity-100 group-hover:opacity-100"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                startEditing()
              }}
            >
              <Pencil size={11} aria-hidden />
            </button>
          )}
        </div>
        {error && (
          <span
            role="alert"
            className="pointer-events-auto max-w-[220px] rounded-[var(--radius-sm)] px-[6px] text-center text-[length:var(--text-caption2)] text-[var(--system-red)]"
          >
            {error}
          </span>
        )}
      </div>
    </div>
  )
}
