import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { X } from "lucide-react"

type ToastTone = "info" | "success" | "error"

interface ToastOptions {
  title: string
  description?: string
  tone?: ToastTone
  durationMs?: number
}

interface ToastRecord extends ToastOptions {
  id: string
}

interface ToastContextValue {
  pushToast: (options: ToastOptions) => void
}

const ToastContext = createContext<ToastContextValue>({
  pushToast: () => {},
})

function toastToneClass(tone: ToastTone): string {
  switch (tone) {
    case "success":
      return "border-[color-mix(in_srgb,var(--system-green)_25%,transparent)] bg-[color-mix(in_srgb,var(--system-green)_12%,var(--material-thick))] text-[var(--text-primary)]"
    case "error":
      return "border-[color-mix(in_srgb,var(--system-red)_30%,transparent)] bg-[color-mix(in_srgb,var(--system-red)_12%,var(--material-thick))] text-[var(--text-primary)]"
    default:
      return "border-[var(--separator)] bg-[var(--material-thick)] text-[var(--text-primary)]"
  }
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastRecord
  onDismiss: (id: string) => void
}) {
  useEffect(() => {
    const timeout = window.setTimeout(() => onDismiss(toast.id), toast.durationMs ?? 4000)
    return () => window.clearTimeout(timeout)
  }, [onDismiss, toast.durationMs, toast.id])

  const tone = toast.tone ?? "info"

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live="polite"
      className={`pointer-events-auto min-w-[280px] max-w-[420px] rounded-[var(--radius-lg)] border px-[var(--space-4)] py-[var(--space-3)] shadow-[var(--shadow-overlay)] backdrop-blur-xl ${toastToneClass(tone)}`}
    >
      <div className="flex items-start gap-[var(--space-3)]">
        <div className="min-w-0 flex-1">
          <div className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)]">
            {toast.title}
          </div>
          {toast.description ? (
            <div className="mt-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
              {toast.description}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label="Dismiss notification"
          className="rounded-full p-1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const pushToast = useCallback((options: ToastOptions) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setToasts((current) => [...current, { ...options, id }])
  }, [])

  const value = useMemo(() => ({ pushToast }), [pushToast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-[max(var(--safe-right),var(--space-4))] top-[max(var(--safe-top),var(--space-4))] z-[400] flex max-h-dvh w-[min(420px,calc(100vw-2*var(--space-4)))] flex-col gap-[var(--space-2)] overflow-hidden">
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
