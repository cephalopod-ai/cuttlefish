import React from 'react'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import type { Employee, SlashCommand } from './chat-input-utils'

interface CommandSuggestionsProps {
  commands: SlashCommand[]
  highlightedIndex: number
  onSelect: (command: SlashCommand) => void
}

export function CommandSuggestions({ commands, highlightedIndex, onSelect }: CommandSuggestionsProps) {
  if (commands.length === 0) return null
  return (
    <div className="absolute bottom-full left-3 right-3 sm:left-4 sm:right-4 mb-1 border-0 bg-[var(--bg-tertiary)] rounded-[var(--radius-lg)] shadow-[var(--shadow-overlay)] max-h-60 overflow-y-auto z-10">
      {commands.map((cmd, idx) => {
        const isHighlighted = idx === highlightedIndex
        return (
          <button
            key={cmd.name}
            ref={(el) => {
              if (isHighlighted && el) el.scrollIntoView({ block: 'nearest' })
            }}
            onClick={() => onSelect(cmd)}
            className={`w-full text-left py-[var(--space-2)] px-[var(--space-3)] text-[length:var(--text-footnote)] ${isHighlighted ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'} border-none cursor-pointer flex items-center gap-[var(--space-2)] text-[var(--text-primary)]`}
          >
            <span className="font-[family-name:var(--font-mono)] font-[var(--weight-semibold)] text-[var(--accent)] text-[length:var(--text-footnote)]">/{cmd.name}</span>
            <span className="text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">{cmd.description}</span>
          </button>
        )
      })}
    </div>
  )
}

interface MentionSuggestionsProps {
  employees: Employee[]
  highlightedIndex: number
  itemRefs: React.MutableRefObject<Map<number, HTMLButtonElement>>
  onSelect: (name: string) => void
}

export function MentionSuggestions({ employees, highlightedIndex, itemRefs, onSelect }: MentionSuggestionsProps) {
  if (employees.length === 0) return null
  return (
    <div className="absolute bottom-full left-3 right-3 sm:left-4 sm:right-4 mb-1 border-0 bg-[var(--bg-tertiary)] rounded-[var(--radius-lg)] shadow-[var(--shadow-overlay)] max-h-40 overflow-y-auto z-10">
      {employees.slice(0, 8).map((emp, idx) => {
        const isHighlighted = idx === highlightedIndex
        return (
          <button
            key={emp.name}
            ref={(el) => {
              if (el) itemRefs.current.set(idx, el)
              else itemRefs.current.delete(idx)
              if (isHighlighted && el) el.scrollIntoView({ block: 'nearest' })
            }}
            onClick={() => onSelect(emp.name)}
            className={`w-full text-left py-[var(--space-2)] px-[var(--space-3)] text-[length:var(--text-footnote)] ${isHighlighted ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'} border-none cursor-pointer flex items-center gap-[var(--space-2)] text-[var(--text-primary)]`}
          >
            <EmployeeAvatar name={emp.name} avatar={emp.avatar} size={20} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-[var(--space-2)]">
                <span className="font-[var(--weight-semibold)]">{emp.displayName || emp.name}</span>
                <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">@{emp.name}</span>
              </div>
              {emp.department && (
                <div className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)] flex gap-[var(--space-2)] mt-px">
                  <span>{emp.department}</span>
                  {emp.engine && (
                    <span className="text-[var(--accent)] font-[var(--weight-medium)]">{emp.engine}</span>
                  )}
                </div>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
