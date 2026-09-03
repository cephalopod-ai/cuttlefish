export const SETUP_ENGINES = ["claude", "codex", "antigravity", "grok", "pi", "kiro", "hermes", "ollama", "kilo", "aider", "vibe"] as const;
export type SetupEngine = (typeof SETUP_ENGINES)[number];

const PREFERRED_SETUP_ENGINES: readonly SetupEngine[] = ["claude", "codex", "antigravity", "grok", "pi", "kiro", "hermes"];

/**
 * Pick the default for a newly-created config from the CLIs setup verified.
 *
 * With one usable engine this returns that engine even in non-interactive setup;
 * with multiple engines it preserves the established Claude → Codex → Antigravity →
 * Grok → Pi → Kiro → Hermes preference order. No verified engine retains the template's Claude
 * default so setup can still create a config and report the missing prerequisite.
 */
export function selectSetupEngine(available: readonly SetupEngine[]): SetupEngine {
  if (available.length === 1) return available[0];
  return PREFERRED_SETUP_ENGINES.find((engine) => available.includes(engine)) ?? available[0] ?? "claude";
}
