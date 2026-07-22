import { AsyncLocalStorage } from "node:async_hooks";

const SECRET_DENYLIST: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GIT_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GCLOUD_SERVICE_KEY",
  "CUTTLEFISH_GATEWAY_TOKEN",
  "CUTTLEFISH_INTERNAL_TOKEN",
  "CUTTLEFISH_SESSION_TOKEN",
]);

const SECRET_PREFIX_DENYLIST = ["TWILIO_"] as const;

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^a-zA-Z0-9]+/)
    .map((segment) => segment.toLowerCase())
    .filter(Boolean);
}

function isSensitiveEnvKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("apikey") ||
    normalized.includes("privatekey") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("bearer") ||
    normalized.includes("cookie") ||
    normalized === "authorization"
  ) {
    return true;
  }
  const segments = keySegments(key);
  return segments.includes("key") || segments.includes("auth") || segments.includes("pat") || segments.includes("dsn") || segments.includes("connstr");
}

export interface EngineEnvOptions {
  stripPrefixes?: string[];
  /** Exact provider credential names an engine requires to authenticate itself. */
  allowSecretKeys?: readonly string[];
}

const turnEnvironment = new AsyncLocalStorage<Record<string, string>>();

/**
 * Scope an explicitly granted per-turn credential to subprocesses spawned by
 * the current engine run. It never mutates process.env, so concurrent sessions
 * cannot observe one another's credentials.
 */
export function runWithEngineEnvironment<T>(
  additions: Record<string, string>,
  run: () => T,
): T {
  return turnEnvironment.run({ ...additions }, run);
}

export function buildEngineEnv(
  additions: Record<string, string> = {},
  opts: EngineEnvOptions = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const allowedSecrets = new Set(opts.allowSecretKeys ?? []);
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Prefix-denied integration credentials are never engine authentication
    // material. Exact provider keys may be granted deliberately, but a broad
    // bypass must never re-expose Twilio or a future prefix-denied secret.
    if (SECRET_PREFIX_DENYLIST.some((prefix) => key.startsWith(prefix))) continue;
    if ((SECRET_DENYLIST.has(key) || isSensitiveEnvKey(key)) && !allowedSecrets.has(key)) continue;
    if (opts.stripPrefixes?.some((prefix) => key.startsWith(prefix))) continue;
    result[key] = value;
  }
  return { ...result, ...(turnEnvironment.getStore() ?? {}), ...additions };
}

export const ENGINE_ENV_SECRET_DENYLIST = SECRET_DENYLIST;
