import { Loader2, type LucideIcon } from "lucide-react"

const iconMotion =
  "absolute inset-0 flex items-center justify-center transition-[opacity,filter,scale] duration-300 [transition-timing-function:cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"

const labelMotion =
  "col-start-1 row-start-1 transition-[opacity,filter,transform] duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none"

interface AuthStateIconProps {
  busy: boolean
  idleIcon: LucideIcon
  busyIcon?: LucideIcon
  size?: number
}

export function AuthStateIcon({ busy, idleIcon: IdleIcon, busyIcon: BusyIcon = Loader2, size = 16 }: AuthStateIconProps) {
  return (
    <span aria-hidden="true" className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <span className={`${iconMotion} ${busy ? "scale-[0.25] opacity-0 blur-[4px]" : "scale-100 opacity-100 blur-0"}`}>
        <IdleIcon size={size} />
      </span>
      <span className={`${iconMotion} ${busy ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-[4px]"}`}>
        <BusyIcon size={size} className={busy ? "animate-spin" : undefined} />
      </span>
    </span>
  )
}

interface AuthStateLabelProps {
  busy: boolean
  idle: string
  busyText: string
  className?: string
}

export function AuthStateLabel({ busy, idle, busyText, className = "" }: AuthStateLabelProps) {
  return (
    <span aria-hidden="true" className={`inline-grid place-items-center overflow-hidden ${className}`}>
      <span className={`${labelMotion} ${busy ? "-translate-y-1 opacity-0 blur-[4px]" : "translate-y-0 opacity-100 blur-0"}`}>
        {idle}
      </span>
      <span className={`${labelMotion} ${busy ? "translate-y-0 opacity-100 blur-0" : "translate-y-1 opacity-0 blur-[4px]"}`}>
        {busyText}
      </span>
    </span>
  )
}
