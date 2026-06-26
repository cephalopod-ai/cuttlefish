/**
 * Onboarding gate policy.
 * The wizard is needed if and only if the `onboarded` flag has not been set.
 * Employees and sessions are irrelevant — setup always seeds an employee,
 * so checking them caused the wizard to never appear.
 */
export function onboardingNeeded(onboarded: boolean): boolean {
  return !onboarded;
}

export interface EngineChoice {
  engine?: string;
  model?: string;
  effortLevel?: string;
}

/**
 * Merges engine/model/effortLevel selections from the onboarding wizard
 * into the gateway config, setting `engines.default` and per-engine fields.
 * Returns the config unchanged (same reference) when no engine is provided.
 */
export function applyEngineChoice<T extends { engines: Record<string, any> }>(
  cfg: T,
  c: EngineChoice
): T {
  if (!c.engine) return cfg;
  const engines: Record<string, any> = { ...cfg.engines, default: c.engine };
  engines[c.engine] = {
    ...(engines[c.engine] ?? {}),
    ...(c.model ? { model: c.model } : {}),
    ...(c.effortLevel ? { effortLevel: c.effortLevel } : {}),
  };
  return { ...cfg, engines } as T;
}
