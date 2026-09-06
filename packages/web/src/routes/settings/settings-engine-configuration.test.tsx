import { useState } from "react"
import { describe, expect, it } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { EngineConfigurationSection as FacadeEngineConfigurationSection } from "./settings-config-sections"
import { EngineConfigurationSection } from "./settings-engine-configuration"
import type { Config } from "./settings-constants"

function setAtPath(config: Config, path: string[], value: unknown): Config {
  const next = structuredClone(config)
  let obj: Record<string, unknown> = next as Record<string, unknown>
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!obj[path[index]] || typeof obj[path[index]] !== "object") obj[path[index]] = {}
    obj = obj[path[index]] as Record<string, unknown>
  }
  obj[path[path.length - 1]] = value
  return next
}

type HarnessProps = {
  initialConfig?: Config
  modelOptions?: (engine: string, fallback: Array<{ value: string; label: string }>) => Array<{ value: string; label: string }>
  effortOptions?: (engine: string, model: string | undefined, fallback: Array<{ value: string; label: string }>) => Array<{ value: string; label: string }>
}

function findSelectByValue(value: string): HTMLSelectElement {
  const select = screen
    .getAllByRole("combobox")
    .find((node) => (node as HTMLSelectElement).value === value) as HTMLSelectElement | undefined
  if (!select) throw new Error(`Expected select with value ${value}`)
  return select
}

function Harness({
  initialConfig,
  modelOptions = (engine, fallback) => (
    engine === "codex"
      ? [
          { value: "gpt-5.6", label: "GPT-5.6" },
          { value: "gpt-5.5", label: "GPT-5.5" },
        ]
      : fallback
  ),
  effortOptions = (_engine, _model, fallback) => fallback,
}: HarnessProps) {
  const [config, setConfig] = useState<Config>(initialConfig ?? {
    engines: {
      claude: { bin: "claude", model: "opus", effortLevel: "medium" },
      codex: { bin: "codex", model: "gpt-5.6", effortLevel: "high" },
      grok: { bin: "grok", model: "grok-build", effortLevel: "high" },
      ollama: { bin: "ollama", model: "gemma4" },
      kilo: { bin: "kilo", model: "default" },
      aider: { bin: "aider", model: "default" },
      default: "claude",
    },
  })

  return (
    <>
      <EngineConfigurationSection
        config={config}
        updateConfig={(path, value) => setConfig((prev) => setAtPath(prev, path, value))}
        updateNumberConfig={() => {}}
        modelOptions={modelOptions}
        effortOptions={effortOptions}
      />
      <output data-testid="config">{JSON.stringify(config)}</output>
    </>
  )
}

describe("EngineConfigurationSection", () => {
  it.each(["claude", "codex", "grok", "ollama", "kilo", "vibe"] as const)(
    "keeps the configured %s model visible when a live registry omits it",
    (engine) => {
      const savedModel = `${engine}-custom-model`
      const initialConfig: Config = { engines: { [engine]: { model: savedModel } } }
      const choices = [{ value: "registry-model", label: "Registry model" }]
      Object.freeze(choices)
      render(<Harness
        initialConfig={initialConfig}
        modelOptions={(name, fallback) => name === engine
          ? choices
          : fallback}
      />)

      expect(choices).toEqual([{ value: "registry-model", label: "Registry model" }])
      const select = findSelectByValue(savedModel)
      expect(Array.from(select.options).map((option) => option.value)).toEqual(["registry-model", savedModel])
      expect(JSON.parse(screen.getByTestId("config").textContent ?? "{}")).toEqual(initialConfig)
      fireEvent.change(select, { target: { value: "registry-model" } })
      expect(JSON.parse(screen.getByTestId("config").textContent ?? "{}").engines[engine].model).toBe("registry-model")
    },
  )

  it("keeps the selected model visible through registry refreshes without changing the draft", () => {
    const initialConfig: Config = { engines: { codex: { model: "configured-model" } } }
    const { rerender } = render(<Harness initialConfig={initialConfig} modelOptions={() => []} />)
    const select = findSelectByValue("configured-model")
    expect(select.options).toHaveLength(1)

    rerender(<Harness initialConfig={initialConfig} modelOptions={(_engine, fallback) => fallback} />)
    expect(findSelectByValue("configured-model")).toBe(select)
    expect(select.options).toHaveLength(1)

    rerender(<Harness initialConfig={initialConfig} modelOptions={(engine, fallback) => engine === "codex"
      ? [{ value: "configured-model", label: "Live model label" }]
      : fallback} />)
    expect(select.selectedOptions[0].textContent).toBe("Live model label")
    expect(select.options).toHaveLength(1)
    rerender(<Harness initialConfig={initialConfig} modelOptions={(engine, fallback) => engine === "codex"
      ? [{ value: "replacement-model", label: "Replacement model" }]
      : fallback} />)
    expect(findSelectByValue("configured-model")).toBe(select)
    expect(select.options).toHaveLength(2)
    expect(JSON.parse(screen.getByTestId("config").textContent ?? "{}")).toEqual(initialConfig)
  })

  it("preserves the existing Grok alias without rewriting the saved draft", () => {
    const initialConfig: Config = { engines: { grok: { model: "grok-build" } } }
    render(<Harness initialConfig={initialConfig} />)
    expect(findSelectByValue("grok-4.6").value).toBe("grok-4.6")
    expect(JSON.parse(screen.getByTestId("config").textContent ?? "{}")).toEqual(initialConfig)
  })

  it("preserves component identity through the original import path", () => {
    expect(FacadeEngineConfigurationSection).toBe(EngineConfigurationSection)
  })

  it("renders Codex model choices from the live registry options", () => {
    render(<Harness />)

    const codexModelSelect = findSelectByValue("gpt-5.6")
    expect(Array.from(codexModelSelect.options).map((option) => option.value)).toEqual(["gpt-5.6", "gpt-5.5"])

    fireEvent.change(codexModelSelect, { target: { value: "gpt-5.5" } })
    expect(codexModelSelect.value).toBe("gpt-5.5")
  })

  it("falls back to the configured Codex model when live registry options are unavailable", () => {
    render(<Harness
      initialConfig={{
        engines: {
          claude: { bin: "claude", model: "opus", effortLevel: "medium" },
          codex: { bin: "codex", model: "gpt-5.4-mini", effortLevel: "high" },
          grok: { bin: "grok", model: "grok-build", effortLevel: "high" },
          ollama: { bin: "ollama", model: "gemma4" },
          kilo: { bin: "kilo", model: "default" },
          aider: { bin: "aider", model: "default" },
          default: "claude",
        },
      }}
      modelOptions={(_engine, fallback) => fallback}
    />)

    const codexModelSelect = findSelectByValue("gpt-5.4-mini")
    expect(Array.from(codexModelSelect.options).map((option) => option.value)).toEqual(["gpt-5.4-mini"])
  })

  it("scopes Codex effort choices to the selected model and resets invalid persisted effort", async () => {
    render(<Harness
      modelOptions={(engine, fallback) => (
        engine === "codex"
          ? [
              { value: "gpt-5.6", label: "GPT-5.6" },
              { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
            ]
          : fallback
      )}
      effortOptions={(engine, model, fallback) => {
        if (engine !== "codex") return fallback
        if (model === "gpt-5.4-mini") {
          return [
            { value: "default", label: "Default" },
            { value: "low", label: "Low" },
          ]
        }
        return [
          { value: "default", label: "Default" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ]
      }}
    />)

    const codexModelSelect = findSelectByValue("gpt-5.6")
    const codexEffortSelect = findSelectByValue("high")
    fireEvent.change(codexModelSelect, { target: { value: "gpt-5.4-mini" } })

    expect(codexEffortSelect.value).toBe("default")
    expect(Array.from(codexEffortSelect.options).map((option) => option.value)).toEqual(["default", "low"])
    await waitFor(() => {
      expect(screen.getByTestId("config").textContent).toContain('"effortLevel":"default"')
    })
  })

  it("writes back default when an existing Codex effort is invalid for the selected model", async () => {
    render(<Harness
      initialConfig={{
        engines: {
          claude: { bin: "claude", model: "opus", effortLevel: "medium" },
          codex: { bin: "codex", model: "gpt-5.4-mini", effortLevel: "high" },
          grok: { bin: "grok", model: "grok-build", effortLevel: "high" },
          ollama: { bin: "ollama", model: "gemma4" },
          kilo: { bin: "kilo", model: "default" },
          aider: { bin: "aider", model: "default" },
          default: "claude",
        },
      }}
      effortOptions={(engine, model, fallback) => {
        if (engine !== "codex") return fallback
        if (model === "gpt-5.4-mini") {
          return [
            { value: "default", label: "Default" },
            { value: "low", label: "Low" },
          ]
        }
        return fallback
      }}
    />)

    expect(findSelectByValue("default").value).toBe("default")
    await waitFor(() => {
      expect(screen.getByTestId("config").textContent).toContain('"effortLevel":"default"')
    })
  })
})
