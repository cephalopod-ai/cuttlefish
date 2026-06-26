import { useEffect, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { LockKeyhole } from "lucide-react"
import { api } from "@/lib/api"

export function AuthGate({ children }: { children: ReactNode }) {
  const [checking, setChecking] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [token, setToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let alive = true
    api.authStatus()
      .then((status) => {
        if (!alive) return
        setAuthenticated(status.authenticated || status.required === false)
      })
      .catch(() => {
        if (!alive) return
        setAuthenticated(false)
      })
      .finally(() => {
        if (alive) setChecking(false)
      })
    return () => { alive = false }
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = token.trim()
    if (!trimmed) return
    setSubmitting(true)
    setError(null)
    try {
      await api.login(trimmed)
      setAuthenticated(true)
      setToken("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed")
    } finally {
      setSubmitting(false)
    }
  }

  if (checking) {
    return <div className="min-h-screen bg-[var(--bg)]" />
  }

  if (authenticated) return <>{children}</>

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text-primary)] flex items-center justify-center px-[var(--space-5)]">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-[360px] border border-[var(--separator)] bg-[var(--material-regular)] rounded-[var(--radius-md)] p-[var(--space-5)] shadow-[var(--shadow-card)]"
      >
        <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)]">
          <span className="w-9 h-9 rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] flex items-center justify-center text-[var(--accent)]">
            <LockKeyhole size={18} />
          </span>
          <div className="min-w-0">
            <h1 className="text-[length:var(--text-title3)] font-[var(--weight-bold)] leading-tight">
              Gateway Login
            </h1>
            <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-1">
              Enter the token from gateway.json.
            </p>
          </div>
        </div>
        <label className="block text-[length:var(--text-caption1)] text-[var(--text-secondary)] mb-[var(--space-2)]">
          Token
        </label>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
          type="password"
          autoComplete="current-password"
          className="w-full h-10 rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--bg)] px-[var(--space-3)] text-[length:var(--text-body)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        {error && (
          <div className="mt-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--system-red)]">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={submitting || !token.trim()}
          className="mt-[var(--space-4)] w-full h-10 rounded-[var(--radius-sm)] border-none bg-[var(--accent)] text-[var(--accent-contrast)] font-[var(--weight-semibold)] text-[length:var(--text-footnote)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {submitting ? "Checking..." : "Unlock"}
        </button>
      </form>
    </main>
  )
}
