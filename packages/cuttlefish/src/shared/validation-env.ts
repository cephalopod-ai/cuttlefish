/**
 * Allowlist-based environment builder for the orchestration validation
 * runner.
 *
 * `shared/engine-env.ts#buildEngineEnv` is a DENYLIST: it starts from the
 * full parent `process.env` and subtracts known-secret-shaped keys. That is
 * a reasonable tradeoff for engine CLIs that need broad ambient environment
 * access (locale, PATH, provider SDK conventions this daemon doesn't
 * enumerate), but a denylist can only catch secret names its authors
 * anticipated — this codebase has already had a real secret leak through
 * exactly this mechanism (a Twilio credential reaching an Aider subprocess
 * once a denylist bypass flag was set).
 *
 * The validation runner spawns contract-declared build/test commands whose
 * subprocess (and any of its own transitive dependencies' install/test
 * hooks) can read its entire environment, so it gets a true ALLOWLIST
 * instead: only a small fixed set of operationally-necessary variables plus
 * whatever provider-credential keys the caller explicitly names. This is
 * deliberately independent of `buildEngineEnv` — it does not call it, so
 * changing this file can never affect `buildEngineEnv`'s existing call
 * sites, and vice versa.
 */

const ALWAYS_ALLOWED_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE", // Windows equivalent of HOME
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SystemRoot", // required for many Windows-native tools to resolve DLLs
  "ComSpec",
] as const;

export interface ValidationEnvOptions {
  /** Additional environment variables to set, applied after the allowlist. */
  additions?: Record<string, string>;
  /**
   * Names of provider-credential environment variables this specific
   * validation step is explicitly allowed to read from the host
   * environment (e.g. a package-registry auth token the declared build
   * genuinely needs). Empty by default — a step that just runs tests should
   * not need any secret.
   */
  allowSecretKeys?: readonly string[];
}

/**
 * Build a minimal, allowlisted environment for a spawned validation-runner
 * subprocess. Only `ALWAYS_ALLOWED_ENV_KEYS` (when actually set) and any
 * caller-declared `allowSecretKeys` are copied from `process.env`; nothing
 * else from the parent process's environment is inherited.
 */
export function buildValidationEnv(opts: ValidationEnvOptions = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ALWAYS_ALLOWED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  for (const key of opts.allowSecretKeys ?? []) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return { ...result, ...(opts.additions ?? {}) };
}
