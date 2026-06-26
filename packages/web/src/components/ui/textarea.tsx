import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({
  className,
  rows = 4,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      rows={rows}
      className={cn(
        "flex w-full resize-y rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--fill-quaternary)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none transition-[color,box-shadow] placeholder:text-[var(--text-tertiary)] focus-visible:border-[var(--accent)] focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
