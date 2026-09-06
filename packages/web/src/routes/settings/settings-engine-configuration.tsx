// Engine binary, model and effort draft editing for the settings page.
// Extracted from settings-config-sections.tsx in a behavior-preserving modularization.
// The facade re-exports EngineConfigurationSection.
import { useEffect } from "react"
import type { SharedConfigProps } from "./settings-config-section-types"
import { FieldHint, FieldRow, Section, SettingsInput, SettingsSelect } from "./settings-fields"

type Option = { value: string; label: string }

interface RegistryProps {
  modelOptions: (engine: string, fallback: Option[]) => Option[]
  effortOptions: (engine: string, model: string | undefined, fallback: Option[]) => Option[]
}

export function EngineConfigurationSection({
  config,
  effortOptions,
  modelOptions,
  updateConfig,
}: SharedConfigProps & RegistryProps) {
  const claudeModel = config.engines?.claude?.model ?? "opus"
  const codexModel = config.engines?.codex?.model ?? "gpt-5.5"
  const grokModel = config.engines?.grok?.model === "grok-build" ? "grok-4.6" : config.engines?.grok?.model ?? "grok-4.6"
  const ollamaModel = config.engines?.ollama?.model ?? "gemma4:26b"
  const kiloModel = config.engines?.kilo?.model ?? "default"
  const vibeModel = config.engines?.vibe?.model ?? "mistral-medium-3.5"

  function configuredModelOptions(engine: string, currentModel: string, fallback: Option[]): Option[] {
    const options = modelOptions(engine, fallback)
    // A registry refresh must not make the select display a different model than the draft.
    return options.some((option) => option.value === currentModel)
      ? options
      : [...options, { value: currentModel, label: `${currentModel} (configured)` }]
  }

  const codexPersistedEffort = config.engines?.codex?.effortLevel
  const codexEffortFallback = [
    { value: "default", label: "Default" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
  ]
  const codexEffortChoices = effortOptions("codex", codexModel, codexEffortFallback)
  const codexPersistedEffortIsValid = codexPersistedEffort == null
    || codexPersistedEffort === "default"
    || codexEffortChoices.some((option) => option.value === codexPersistedEffort)
  const codexEffortValue = codexPersistedEffortIsValid
    ? (codexPersistedEffort ?? "default")
    : "default"

  useEffect(() => {
    if (!codexPersistedEffort || codexPersistedEffort === "default" || codexPersistedEffortIsValid) return
    updateConfig(["engines", "codex", "effortLevel"], "default")
  }, [codexPersistedEffort, codexPersistedEffortIsValid, updateConfig])

  return (
    <Section title="Engine Configuration">
      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Claude
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.claude?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "claude", "bin"], v)}
          placeholder="claude"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsSelect
          value={claudeModel}
          onChange={(v) => updateConfig(["engines", "claude", "model"], v)}
          options={configuredModelOptions("claude", claudeModel, [
            { value: "claude-fable-5-1", label: "Fable 5.1" },
            { value: "claude-opus-5", label: "Opus 5" },
            { value: "opus", label: "Opus" },
            { value: "sonnet", label: "Sonnet" },
            { value: "haiku", label: "Haiku" },
          ])}
        />
      </FieldRow>
      <FieldRow label="Effort Level">
        <SettingsSelect
          value={config.engines?.claude?.effortLevel ?? "default"}
          onChange={(v) => updateConfig(["engines", "claude", "effortLevel"], v)}
          options={effortOptions("claude", claudeModel, [
            { value: "default", label: "Default" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ])}
        />
      </FieldRow>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Codex
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.codex?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "codex", "bin"], v)}
          placeholder="codex"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsSelect
          value={codexModel}
          onChange={(v) => {
            updateConfig(["engines", "codex", "model"], v)
            if (!effortOptions("codex", v, codexEffortFallback).some((option) => option.value === (codexPersistedEffort ?? "default"))) {
              updateConfig(["engines", "codex", "effortLevel"], "default")
            }
          }}
          options={configuredModelOptions("codex", codexModel, [{ value: codexModel, label: codexModel }])}
        />
      </FieldRow>
      <FieldRow label="Effort Level">
        <SettingsSelect
          value={codexEffortValue}
          onChange={(v) => updateConfig(["engines", "codex", "effortLevel"], v)}
          options={codexEffortChoices}
        />
      </FieldRow>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Grok
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.grok?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "grok", "bin"], v)}
          placeholder="grok"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsSelect
          value={grokModel}
          onChange={(v) => updateConfig(["engines", "grok", "model"], v)}
          options={configuredModelOptions("grok", grokModel, [
            { value: "grok-4.6", label: "Grok 4.6" },
            { value: "grok-4.5", label: "Grok 4.5" },
          ])}
        />
      </FieldRow>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Ollama
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.ollama?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "ollama", "bin"], v)}
          placeholder="ollama"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsSelect
          value={ollamaModel}
          onChange={(v) => updateConfig(["engines", "ollama", "model"], v)}
          options={configuredModelOptions("ollama", ollamaModel, [
            { value: "gemma4:26b", label: "Gemma 4 26B" },
          ])}
        />
      </FieldRow>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Kilo
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.kilo?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "kilo", "bin"], v)}
          placeholder="kilo"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsSelect
          value={kiloModel}
          onChange={(v) => updateConfig(["engines", "kilo", "model"], v)}
          options={configuredModelOptions("kilo", kiloModel, [
            { value: "default", label: "Kilo (auto)" },
          ])}
        />
      </FieldRow>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Aider
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.aider?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "aider", "bin"], v)}
          placeholder="aider"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsInput
          value={config.engines?.aider?.model ?? ""}
          onChange={(v) => updateConfig(["engines", "aider", "model"], v)}
          placeholder="default (auto-detect from API key)"
        />
      </FieldRow>
      <FieldHint>
        Leave the model as "default" to let aider auto-detect from whichever provider
        API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) is set in the gateway's
        environment.
      </FieldHint>

      <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />

      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Vibe
      </div>
      <FieldRow label="Binary Path">
        <SettingsInput
          value={config.engines?.vibe?.bin ?? ""}
          onChange={(v) => updateConfig(["engines", "vibe", "bin"], v)}
          placeholder="vibe-acp"
        />
      </FieldRow>
      <FieldRow label="Model">
        <SettingsSelect
          value={vibeModel}
          onChange={(v) => updateConfig(["engines", "vibe", "model"], v)}
          options={configuredModelOptions("vibe", vibeModel, [
            { value: "mistral-medium-3.5", label: "Mistral Medium 3.5" },
          ])}
        />
      </FieldRow>
      <FieldHint>
        Mistral AI's Vibe CLI, run via its dedicated ACP entrypoint (vibe-acp). Requires
        Vibe to already be installed and authenticated (run `vibe --setup`).
      </FieldHint>
    </Section>
  )
}
