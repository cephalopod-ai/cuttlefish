import type React from "react"
import { createContext, useContext, useId } from "react"

// Shared label identity keeps visual rows and nested form controls associated.
const SettingsFieldContext = createContext<{ labelId: string; controlId?: string } | null>(null)

function useSettingsField() {
  const field = useContext(SettingsFieldContext)
  const ownId = useId()
  return { labelId: field?.labelId, controlId: field?.controlId ?? ownId }
}

export function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-[var(--space-6)]">
      <div
        className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] tracking-[var(--tracking-wide)] uppercase text-[var(--text-tertiary)] px-[var(--space-2)] pb-[var(--space-2)]"
      >
        {title}
      </div>
      <div
        className="bg-[var(--material-regular)] rounded-[var(--radius-md)] border border-[var(--separator)] p-[var(--space-4)]"
      >
        {children}
      </div>
    </section>
  )
}

export function FieldRow({
  label,
  children,
  multiple = false,
}: {
  label: string
  children: React.ReactNode
  multiple?: boolean
}) {
  const labelId = useId()
  const controlId = multiple ? undefined : `${labelId}-control`
  const Label = multiple ? "span" : "label"
  return (
    <div
      role={multiple ? "group" : undefined}
      aria-labelledby={multiple ? labelId : undefined}
      className="flex items-center justify-between py-[var(--space-2)] gap-[var(--space-4)]"
    >
      <Label
        id={labelId}
        htmlFor={controlId}
        className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)] shrink-0"
      >
        {label}
      </Label>
      <SettingsFieldContext.Provider value={{ labelId, controlId }}>
        <div className="w-[240px] shrink-0">{children}</div>
      </SettingsFieldContext.Provider>
    </div>
  )
}

export function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-[4px] text-[length:var(--text-caption1)] text-[var(--label-secondary)]">
      {children}
    </div>
  )
}

export function SettingsInput({
  value,
  onChange,
  type = "text",
  placeholder,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  ariaLabel?: string
}) {
  const field = useSettingsField()
  return (
    <input
      id={field.controlId}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : field.labelId}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
    />
  )
}

export function SettingsTextarea({
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
}) {
  const field = useSettingsField()
  return (
    <textarea
      id={field.controlId}
      aria-labelledby={field.labelId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[8px] text-[length:var(--text-footnote)] text-[var(--text-primary)] resize-y"
    />
  )
}

export function SettingsSelect({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  const field = useSettingsField()
  return (
    <select
      id={field.controlId}
      aria-labelledby={field.labelId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)] cursor-pointer"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  ariaLabel?: string
}) {
  const field = useSettingsField()
  return (
    <button
      type="button"
      id={field.controlId}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : field.labelId}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="w-[44px] h-[24px] rounded-[12px] border-none cursor-pointer relative shrink-0 transition-[background] duration-200 ease-[var(--ease-smooth)]"
      style={{
        background: checked ? "var(--system-green)" : "var(--fill-primary)",
      }}
    >
      <span
        className="absolute top-[2px] w-[20px] h-[20px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-[left] duration-200 ease-[var(--ease-spring)]"
        style={{
          left: checked ? 22 : 2,
        }}
      />
    </button>
  )
}
