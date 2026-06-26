import { useState } from "react"
import { ArrowDown, ArrowUp, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const PICKER_PLACEHOLDER = "__add_supervisor__"

export function normalizeReportsTo(reportsTo: string | string[] | undefined): string[] {
  if (!reportsTo) return []
  return Array.isArray(reportsTo) ? [...reportsTo] : [reportsTo]
}

export function serializeReportsTo(reportsTo: string[]): string | string[] | undefined {
  if (reportsTo.length === 0) return undefined
  return reportsTo.length === 1 ? reportsTo[0] : reportsTo
}

export function ReportsToField({
  value,
  options,
  hint,
  disabled = false,
  onChange,
}: {
  value: string[]
  options: string[]
  hint?: string
  disabled?: boolean
  onChange: (next: string[]) => void
}) {
  const [pickerValue, setPickerValue] = useState(PICKER_PLACEHOLDER)
  const available = options.filter((option) => !value.includes(option))

  function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= value.length) return
    const next = [...value]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    onChange(next)
  }

  function remove(name: string) {
    onChange(value.filter((entry) => entry !== name))
  }

  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <Select
        value={pickerValue}
        onValueChange={(next) => {
          setPickerValue(PICKER_PLACEHOLDER)
          if (next === PICKER_PLACEHOLDER) return
          onChange([...value, next])
        }}
        disabled={disabled || available.length === 0}
      >
        <SelectTrigger aria-label="Add supervisor">
          <SelectValue placeholder={available.length === 0 ? "No more supervisors available" : "Add supervisor"} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PICKER_PLACEHOLDER}>Add supervisor</SelectItem>
          {available.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {value.length === 0 ? (
        <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--separator)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
          No supervisors assigned. The agent stays top level until you add one.
        </div>
      ) : (
        <div className="flex flex-col gap-[var(--space-2)]">
          {value.map((name, index) => (
            <div
              key={`${name}-${index}`}
              className="flex items-center gap-[var(--space-2)] rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--fill-quaternary)] px-[var(--space-3)] py-[var(--space-2)]"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{name}</div>
                <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                  {index === 0 ? "Primary manager" : `Secondary matrix link ${index}`}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Move ${name} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Move ${name} down`}
                  disabled={index === value.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${name}`}
                  onClick={() => remove(name)}
                >
                  <X />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {hint ? (
        <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">{hint}</span>
      ) : null}
    </div>
  )
}
