import type { Config } from "./settings-constants"

type FallbackTarget = NonNullable<NonNullable<Config["modelFallback"]>["globalChain"]>[number]

export function formatLineList(values: string[] | undefined): string {
  return (values ?? []).join("\n")
}

export function parseLineList(value: string): string[] | undefined {
  const parsed = value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
  return parsed.length > 0 ? parsed : undefined
}

export function formatFallbackChain(chain: FallbackTarget[] | undefined): string {
  return (chain ?? []).map((entry) => {
    const columns = [
      entry.engine ?? "",
      entry.model ?? "",
      entry.effortLevel ?? "",
      entry.employee ?? "",
      entry.reason ?? "",
    ]
    while (columns.length > 0 && !columns[columns.length - 1]) columns.pop()
    return columns.join(" | ")
  }).join("\n")
}

export function parseFallbackChain(value: string): FallbackTarget[] | undefined {
  const lines = value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (lines.length === 0) return undefined

  const chain = lines.map((line) => {
    const [engine = "", model = "", effortLevel = "", employee = "", reason = ""] = line.split("|").map((part) => part.trim())
    const target: FallbackTarget = { engine }
    if (model) target.model = model
    if (effortLevel) target.effortLevel = effortLevel
    if (employee) target.employee = employee
    if (reason) target.reason = reason
    return target
  }).filter((entry) => entry.engine)

  return chain.length > 0 ? chain : undefined
}
