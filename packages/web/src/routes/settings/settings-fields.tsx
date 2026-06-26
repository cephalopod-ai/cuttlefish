import type React from "react"

// Presentational form primitives for the settings page (no local state; all
// driven by props). Extracted from settings/page.tsx (audit AS-001
// modularization) — no behavior change.

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
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div
      className="flex items-center justify-between py-[var(--space-2)] gap-[var(--space-4)]"
    >
      <label
        className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)] shrink-0"
      >
        {label}
      </label>
      <div className="w-[240px] shrink-0">{children}</div>
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
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <input
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
  return (
    <textarea
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
  return (
    <select
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
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
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
