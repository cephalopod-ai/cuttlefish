/**
 * UPS-A7: shown when a save is refused because `config.yaml` moved on.
 *
 * Deliberately not the error toast every other failure gets: nothing went wrong
 * with this save, it simply has not happened yet, and the operator's own
 * terminal edit is why. There is no retry button — a retry is exactly the
 * clobber this notice exists to prevent — only Reload, which re-reads the file
 * and adopts its revision.
 */
export function ConfigConflictNotice({
  message,
  onReload,
  reloading,
}: {
  message: string | null
  onReload: () => void
  reloading?: boolean
}) {
  if (!message) return null
  return (
    <div
      role="status"
      className="mb-[var(--space-4)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] text-[length:var(--text-footnote)] flex items-center justify-between gap-[var(--space-3)]"
      style={{
        background: "rgba(245,158,11,0.1)",
        border: "1px solid rgba(245,158,11,0.3)",
        color: "var(--system-orange, #b45309)",
      }}
    >
      <span>
        {message}{" "}
        <span style={{ opacity: 0.85 }}>Reloading shows the file as it is now and discards the edits on this page.</span>
      </span>
      <button
        type="button"
        onClick={onReload}
        disabled={reloading}
        className="shrink-0 px-[var(--space-3)] py-[var(--space-1)] rounded-[var(--radius-sm)] font-[var(--weight-medium)] disabled:opacity-50"
        style={{ border: "1px solid rgba(245,158,11,0.5)" }}
      >
        {reloading ? "Reloading…" : "Reload"}
      </button>
    </div>
  )
}
