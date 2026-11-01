import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { GatewayWorkspacesSection, RecoveryFallbacksSection } from "./settings-config-sections"
import type { Config } from "./settings-constants"

const supportedEngines = ["claude", "codex", "antigravity", "grok", "pi", "kiro", "hermes", "ollama", "kilo", "aider", "vibe"] as const

describe("settings engine selection", () => {
  it.each(supportedEngines)("displays and allows the supported %s default and fallback", (engine) => {
    const updateConfig = vi.fn()
    const config: Config = { engines: { default: engine }, sessions: { fallbackEngine: engine } }
    render(<>
      <GatewayWorkspacesSection config={config} updateConfig={updateConfig} updateNumberConfig={vi.fn()} />
      <RecoveryFallbacksSection config={config} updateConfig={updateConfig} updateNumberConfig={vi.fn()} />
    </>)
    const defaultSelect = screen.getByRole("combobox", { name: "Default Engine" }) as HTMLSelectElement
    const fallbackSelect = screen.getByRole("combobox", { name: "Fallback Engine" }) as HTMLSelectElement
    expect(defaultSelect.value).toBe(engine)
    expect(fallbackSelect.value).toBe(engine)
    expect(Array.from(defaultSelect.options).map(option => option.value)).toEqual(supportedEngines)
    expect(Array.from(fallbackSelect.options).map(option => option.value)).toEqual(supportedEngines)
    fireEvent.change(defaultSelect, { target: { value: engine } })
    fireEvent.change(fallbackSelect, { target: { value: engine } })
    expect(updateConfig).toHaveBeenCalledWith(["engines", "default"], engine)
    expect(updateConfig).toHaveBeenCalledWith(["sessions", "fallbackEngine"], engine)
  })
})
