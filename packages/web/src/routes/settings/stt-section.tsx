import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { WHISPER_LANGUAGES } from "./settings-constants"
import { Section } from "./settings-fields"

// Voice Input (STT) settings section — self-contained state.
// Extracted from settings/page.tsx (audit AS-001 modularization) — no behavior change.

export function SttSettingsSection() {
  const [status, setStatus] = useState<{
    available: boolean
    model: string | null
    downloading: boolean
    progress: number
    languages: string[]
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [addLang, setAddLang] = useState("")

  useEffect(() => {
    api.sttStatus().then(setStatus).catch(() => {})
  }, [])

  // Poll for download progress
  useEffect(() => {
    if (!status?.downloading) return
    const timer = setInterval(() => {
      api.sttStatus().then(setStatus).catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [status?.downloading])

  function handleRemoveLanguage(code: string) {
    if (!status || status.languages.length <= 1) return
    const next = status.languages.filter((l) => l !== code)
    setSaving(true)
    api.sttUpdateConfig(next)
      .then(() => setStatus((prev) => prev ? { ...prev, languages: next } : prev))
      .catch(() => {})
      .finally(() => setSaving(false))
  }

  function handleAddLanguage() {
    if (!addLang || !status || status.languages.includes(addLang)) return
    const next = [...status.languages, addLang]
    setSaving(true)
    setAddLang("")
    api.sttUpdateConfig(next)
      .then(() => setStatus((prev) => prev ? { ...prev, languages: next } : prev))
      .catch(() => {})
      .finally(() => setSaving(false))
  }

  function handleDownload() {
    api.sttDownload()
      .then(() => setStatus((prev) => prev ? { ...prev, downloading: true, progress: 0 } : prev))
      .catch(() => {})
  }

  if (!status) return null

  const availableLangs = Object.entries(WHISPER_LANGUAGES)
    .filter(([code]) => !status.languages.includes(code))
    .sort((a, b) => a[1].localeCompare(b[1]))

  return (
    <Section title="Voice Input">
      {/* Status row */}
      <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)]">
        <div
          className="w-[8px] h-[8px] rounded-full shrink-0"
          style={{
            background: status.available ? "var(--system-green)" : "var(--system-red)",
          }}
        />
        <div className="flex-1">
          <div className="text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">
            {status.available
              ? `Whisper ${(status.model || "small").charAt(0).toUpperCase() + (status.model || "small").slice(1)}`
              : "No model installed"}
          </div>
          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            {status.available
              ? "Offline speech recognition ready"
              : "Download a model to enable voice input"}
          </div>
        </div>
      </div>

      {/* Download section */}
      {!status.available && !status.downloading && (
        <button
          onClick={handleDownload}
          className="w-full p-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-semibold)] mb-[var(--space-4)]"
        >
          Download Whisper Small (~500MB)
        </button>
      )}

      {/* Download progress */}
      {status.downloading && (
        <div className="mb-[var(--space-4)]">
          <div className="flex justify-between mb-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            <span>Downloading model…</span>
            <span>{status.progress}%</span>
          </div>
          <div className="h-[6px] rounded-[3px] bg-[var(--fill-tertiary)] overflow-hidden">
            <div
              className="h-full rounded-[3px] bg-[var(--accent)] transition-[width] duration-300 ease-out"
              style={{
                width: `${status.progress}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Languages section — only when model is available */}
      {status.available && (
        <>
          <div className="border-t border-[var(--separator)] mt-[var(--space-2)] pt-[var(--space-3)]">
            <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
              Transcription Languages
            </div>
            <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
              First language is the default. Add multiple to show a language picker in chat.
            </div>

            {/* Language chips */}
            <div className="flex flex-wrap gap-[var(--space-2)] mb-[var(--space-3)]">
              {status.languages.map((code) => (
                <div
                  key={code}
                  className="inline-flex items-center gap-[var(--space-1)] px-[8px] py-[3px] rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-primary)]"
                >
                  <span className="font-[family-name:var(--font-mono)] uppercase text-[length:var(--text-caption2)] font-[var(--weight-semibold)] text-[var(--accent)] mr-[2px]">
                    {code}
                  </span>
                  {WHISPER_LANGUAGES[code] || code}
                  {status.languages.length > 1 && (
                    <button
                      onClick={() => handleRemoveLanguage(code)}
                      disabled={saving}
                      aria-label={`Remove ${WHISPER_LANGUAGES[code] || code}`}
                      className="bg-none border-none cursor-pointer p-0 ml-[2px] text-[var(--text-quaternary)] text-[14px] leading-none flex items-center"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Add language */}
            <div className="flex gap-[var(--space-2)]">
              <select
                value={addLang}
                onChange={(e) => setAddLang(e.target.value)}
                className="flex-1 bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] cursor-pointer"
                style={{
                  color: addLang ? "var(--text-primary)" : "var(--text-tertiary)",
                }}
              >
                <option value="">Add a language…</option>
                {availableLangs.map(([code, name]) => (
                  <option key={code} value={code}>
                    {code.toUpperCase()} — {name}
                  </option>
                ))}
              </select>
              <button
                onClick={handleAddLanguage}
                disabled={!addLang || saving}
                className="px-[14px] py-[6px] rounded-[var(--radius-sm)] border-none text-[length:var(--text-footnote)] font-[var(--weight-semibold)] shrink-0"
                style={{
                  background: addLang ? "var(--accent)" : "var(--fill-tertiary)",
                  color: addLang ? "var(--accent-contrast)" : "var(--text-quaternary)",
                  cursor: addLang ? "pointer" : "default",
                }}
              >
                Add
              </button>
            </div>
          </div>
        </>
      )}
    </Section>
  )
}
