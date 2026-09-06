// IMAP inbox draft editing for the settings page.
// Extracted from settings-config-sections.tsx in a behavior-preserving modularization.
// The facade re-exports EmailSettingsSection.
import type { Config } from "./settings-constants"
import type { SharedConfigProps } from "./settings-config-section-types"
import { FieldHint, FieldRow, Section, SettingsInput, ToggleSwitch } from "./settings-fields"

type EmailInbox = NonNullable<NonNullable<Config["email"]>["inboxes"]>[number]

function nextInboxId(inboxes: EmailInbox[]): string {
  const taken = new Set(inboxes.map((inbox) => inbox.id).filter((id): id is string => typeof id === "string" && id.length > 0))
  for (let index = 1; index <= 3; index += 1) {
    const candidate = `inbox-${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `inbox-${inboxes.length + 1}`
}

function createInboxDraft(inboxes: EmailInbox[]): EmailInbox {
  return {
    id: nextInboxId(inboxes),
    label: `Inbox ${inboxes.length + 1}`,
    address: "",
    username: "",
    password: "",
    imapHost: "",
    imapPort: 993,
    useTls: true,
    folder: "INBOX",
    autoIngest: true,
    unreadOnly: true,
    maxMessagesPerPoll: 10,
  }
}

export function EmailSettingsSection({
  config,
  updateConfig,
  updateNumberConfig,
}: SharedConfigProps) {
  const inboxes = config.email?.inboxes ?? []

  function updateInbox(index: number, patch: Partial<EmailInbox>) {
    const next = inboxes.map((inbox, currentIndex) => (
      currentIndex === index ? { ...inbox, ...patch } : inbox
    ))
    updateConfig(["email", "inboxes"], next)
  }

  function removeInbox(index: number) {
    const next = inboxes.filter((_, currentIndex) => currentIndex !== index)
    updateConfig(["email", "inboxes"], next.length > 0 ? next : undefined)
  }

  function addInbox() {
    if (inboxes.length >= 3) return
    updateConfig(["email", "inboxes"], [...inboxes, createInboxDraft(inboxes)])
  }

  return (
    <Section title="Email Inboxes">
      <FieldRow label="Enabled">
        <ToggleSwitch
          checked={config.email?.enabled ?? false}
          onChange={(v) => updateConfig(["email", "enabled"], v)}
        />
      </FieldRow>
      <FieldRow label="Poll Interval (s)">
        <SettingsInput
          type="number"
          value={String(config.email?.pollIntervalSeconds ?? "")}
          onChange={(v) => updateNumberConfig(["email", "pollIntervalSeconds"], v)}
          placeholder="60"
        />
      </FieldRow>
      <FieldHint>
        Configure up to 3 IMAP inboxes. New mail can be cached for inspection or auto-ingested into a COO-owned session.
      </FieldHint>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="flex items-center justify-between gap-[var(--space-3)] mb-[var(--space-3)]">
        <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">
          Configured inboxes: {inboxes.length}/3
        </div>
        <button
          type="button"
          onClick={addInbox}
          disabled={inboxes.length >= 3}
          className="px-[10px] py-[6px] rounded-[var(--radius-sm)] border border-[var(--separator)] text-[length:var(--text-footnote)] disabled:opacity-50"
        >
          Add inbox
        </button>
      </div>

      {inboxes.map((inbox, index) => (
        <div
          key={`email-inbox-${index}`}
          className="mb-[var(--space-4)] rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--bg-secondary)] p-[var(--space-3)]"
        >
          <div className="flex items-center justify-between gap-[var(--space-3)] mb-[var(--space-2)]">
            <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              {inbox.label?.trim() || inbox.id || `Inbox ${index + 1}`}
            </div>
            <button
              type="button"
              onClick={() => removeInbox(index)}
              className="px-[10px] py-[6px] rounded-[var(--radius-sm)] border border-[var(--separator)] text-[length:var(--text-footnote)]"
            >
              Remove
            </button>
          </div>

          <FieldRow label="Inbox ID">
            <SettingsInput
              value={inbox.id ?? ""}
              onChange={(v) => updateInbox(index, { id: v })}
              placeholder="ops-support"
            />
          </FieldRow>
          <FieldRow label="Label">
            <SettingsInput
              value={inbox.label ?? ""}
              onChange={(v) => updateInbox(index, { label: v })}
              placeholder="Support Inbox"
            />
          </FieldRow>
          <FieldRow label="Email Address">
            <SettingsInput
              value={inbox.address ?? ""}
              onChange={(v) => updateInbox(index, { address: v })}
              placeholder="support@example.com"
            />
          </FieldRow>
          <FieldRow label="Username">
            <SettingsInput
              value={inbox.username ?? ""}
              onChange={(v) => updateInbox(index, { username: v })}
              placeholder="support@example.com"
            />
          </FieldRow>
          <FieldRow label="Password">
            <SettingsInput
              type="password"
              value={inbox.password ?? ""}
              onChange={(v) => updateInbox(index, { password: v })}
              placeholder="app password"
            />
          </FieldRow>
          <FieldRow label="IMAP Host">
            <SettingsInput
              value={inbox.imapHost ?? ""}
              onChange={(v) => updateInbox(index, { imapHost: v })}
              placeholder="imap.gmail.com"
            />
          </FieldRow>
          <FieldRow label="IMAP Port">
            <SettingsInput
              type="number"
              value={String(inbox.imapPort ?? "")}
              onChange={(v) => updateInbox(index, { imapPort: v.trim() ? Number(v) : undefined })}
              placeholder="993"
            />
          </FieldRow>
          <FieldRow label="Folder">
            <SettingsInput
              value={inbox.folder ?? ""}
              onChange={(v) => updateInbox(index, { folder: v })}
              placeholder="INBOX"
            />
          </FieldRow>
          <FieldRow label="Use TLS">
            <ToggleSwitch
              checked={inbox.useTls ?? true}
              onChange={(v) => updateInbox(index, { useTls: v })}
            />
          </FieldRow>
          <FieldRow label="Unread Only">
            <ToggleSwitch
              checked={inbox.unreadOnly ?? true}
              onChange={(v) => updateInbox(index, { unreadOnly: v })}
            />
          </FieldRow>
          <FieldRow label="Auto-Ingest">
            <ToggleSwitch
              checked={inbox.autoIngest ?? true}
              onChange={(v) => updateInbox(index, { autoIngest: v })}
            />
          </FieldRow>
          <FieldRow label="Max Messages/Poll">
            <SettingsInput
              type="number"
              value={String(inbox.maxMessagesPerPoll ?? "")}
              onChange={(v) => updateInbox(index, { maxMessagesPerPoll: v.trim() ? Number(v) : undefined })}
              placeholder="10"
            />
          </FieldRow>
        </div>
      ))}

      {inboxes.length === 0 ? (
        <div className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
          No inboxes configured yet.
        </div>
      ) : null}
    </Section>
  )
}
