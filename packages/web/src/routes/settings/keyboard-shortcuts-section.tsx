import { setSingleKeyShortcutsEnabled, useSingleKeyShortcutsEnabled } from "@/hooks/use-shortcuts-enabled"
import { FieldHint, FieldRow, Section, ToggleSwitch } from "./settings-fields"

// DESIGN-006 / WCAG 2.1.4 (Character Key Shortcuts): the app's single-letter
// shortcuts (chat: n/j/k/e/c/?//, global: g then <key>) previously had no
// way to be turned off. Self-contained, like SttSettingsSection — the on/off
// state lives in use-shortcuts-enabled.ts, not the main CuttlefishSettings
// blob, since it's consumed directly by the low-level shortcut hooks.
export function KeyboardShortcutsSection() {
  const enabled = useSingleKeyShortcutsEnabled()

  return (
    <Section title="Keyboard Shortcuts">
      <FieldRow label="Single-letter shortcuts">
        <ToggleSwitch checked={enabled} onChange={setSingleKeyShortcutsEnabled} />
      </FieldRow>
      <FieldHint>
        Controls single-letter shortcuts with no modifier key, like "n" for new chat or
        "g" then a letter to jump to a page. Shortcuts that require Cmd/Ctrl are always
        on.
      </FieldHint>
    </Section>
  )
}
