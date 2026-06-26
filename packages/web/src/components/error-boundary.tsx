import { Component, type ReactNode } from "react"

interface Props {
  children: ReactNode
  /** Rendered instead of children after a child throws. */
  fallback?: ReactNode
  /**
   * When this value changes after an error, the boundary clears and retries —
   * so a corrected payload (e.g. the orchestrator re-pushing a valid card set)
   * recovers instead of staying stuck on the fallback.
   */
  resetKey?: unknown
  /** Optional label for the console error. */
  label?: string
}

interface State {
  error: Error | null
}

/**
 * Minimal error boundary. Used to fence off the Talk card deck so one malformed
 * card payload degrades to a small "card failed" fallback instead of unmounting
 * the whole app (there is otherwise no boundary above the Talk tree). Mirrors
 * the inline ChatErrorBoundary pattern in routes/chat/page.tsx.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}]`, error.message)
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) return this.props.fallback ?? null
    return this.props.children
  }
}
