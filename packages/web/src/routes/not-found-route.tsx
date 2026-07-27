import { Link } from "react-router-dom"

// DESIGN-007: unknown paths used to silently redirect to "/" (main.tsx's
// wildcard route), giving no indication a URL was wrong — a stale bookmark,
// a typo, or a broken deep link all looked identical to a normal visit to
// Chat. A dedicated 404 tells the user what happened and gets them back.
export default function NotFoundRoute() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center">
      <div className="text-[length:var(--text-title2)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
        Page not found
      </div>
      <div className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
        There's nothing here.
      </div>
      <Link
        to="/"
        className="mt-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-2 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--accent-contrast)] transition-transform active:scale-[0.96]"
      >
        Go home
      </Link>
    </div>
  )
}
