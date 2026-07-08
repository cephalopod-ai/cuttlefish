import { describe, expect, it } from "vitest"
import type { EnginesResponse } from "@/lib/api"
import { registryEffortOptions } from "./page"

const fallback = [
  { value: "default", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
]

describe("registryEffortOptions", () => {
  it("returns only default when the selected registry model has no effort support", () => {
    const registry: EnginesResponse = {
      default: "codex",
      engines: {
        codex: {
          name: "codex",
          available: true,
          defaultModel: "gpt-5.6",
          effortMechanism: "codex-config",
          models: [
            { id: "gpt-5.6", label: "GPT-5.6", supportsEffort: false, effortLevels: [] },
          ],
        },
      },
    }

    expect(registryEffortOptions(registry, "codex", "gpt-5.6", fallback)).toEqual([
      { value: "default", label: "Default" },
    ])
  })

  it("preserves the generic fallback only when the registry or selected model is unavailable", () => {
    const registry: EnginesResponse = {
      default: "codex",
      engines: {
        codex: {
          name: "codex",
          available: true,
          defaultModel: "gpt-5.6",
          effortMechanism: "codex-config",
          models: [
            { id: "gpt-5.6", label: "GPT-5.6", supportsEffort: true, effortLevels: ["low", "high"] },
          ],
        },
      },
    }

    expect(registryEffortOptions(undefined, "codex", "gpt-5.6", fallback)).toEqual(fallback)
    expect(registryEffortOptions(registry, "codex", "gpt-5.5", fallback)).toEqual(fallback)
  })
})
