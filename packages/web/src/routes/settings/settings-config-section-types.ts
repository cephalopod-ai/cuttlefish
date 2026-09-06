// Shared draft-edit callbacks for settings configuration sections.
// Extracted from settings-config-sections.tsx in a behavior-preserving modularization.
// SharedConfigProps is internal; the facade does not re-export it.
import type { Config } from "./settings-constants"

export interface SharedConfigProps {
  config: Config
  updateConfig: (path: string[], value: unknown) => void
  updateNumberConfig: (path: string[], value: string) => void
}
