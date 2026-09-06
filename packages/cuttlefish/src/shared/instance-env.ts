import os from "node:os";
import path from "node:path";

/**
 * UPS-A9: the environment variables that say *which Cuttlefish instance a
 * process belongs to*.
 *
 * A shell inside a live Cuttlefish session carries these, and any child it
 * spawns inherits them. That is correct for the gateway's own children and
 * wrong for everything else: a test worker, a smoke script or a sandbox helper
 * that inherits `CUTTLEFISH_HOME` / `CUTTLEFISH_GATEWAY_URL` /
 * `CUTTLEFISH_GATEWAY_TOKEN` silently reads the operator's real instance and,
 * if it writes, writes to it — which is how a helper meant for a throwaway
 * sandbox ends up aimed at the live gateway.
 *
 * One list, so a new variable cannot be added in one place and forgotten in the
 * three that have to scrub it.
 *
 * NOTE: `vitest.setup.ts` keeps its own copy rather than importing this module.
 * A setup file's imports are instantiated before every test module, and pulling
 * a paths-aware module in there would cache it against the real `node:os`
 * before a test could mock it. `instance-env-list.test.ts` asserts the two lists
 * stay identical.
 */
export const INSTANCE_IDENTITY_ENV_VARS = [
  "CUTTLEFISH_HOME",
  "CUTTLEFISH_INSTANCE",
  "CUTTLEFISH_HOST",
  "CUTTLEFISH_PORT",
  "CUTTLEFISH_GATEWAY_URL",
  "CUTTLEFISH_GATEWAY_TOKEN",
  "CUTTLEFISH_SESSION_ID",
  "CUTTLEFISH_INSTANCES_REGISTRY",
  "CUTTLEFISH_BROWSER_BOOTSTRAP_TOKEN",
] as const;

export type InstanceIdentityEnvVar = (typeof INSTANCE_IDENTITY_ENV_VARS)[number];

/**
 * A copy of `env` with every instance-identity variable removed.
 *
 * Use it when building the environment for a child that does NOT belong to this
 * instance. A child that *does* belong to it should inherit them unchanged.
 */
export function withoutInstanceIdentityEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of INSTANCE_IDENTITY_ENV_VARS) delete next[key];
  return next;
}

/** Remove the instance-identity variables from `env` in place. */
export function scrubInstanceIdentityEnv(env: NodeJS.ProcessEnv): InstanceIdentityEnvVar[] {
  const removed: InstanceIdentityEnvVar[] = [];
  for (const key of INSTANCE_IDENTITY_ENV_VARS) {
    if (env[key] !== undefined) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

/** The instance home a default install uses. */
export function defaultInstanceHome(homedir: string = os.homedir()): string {
  return path.join(homedir, ".cuttlefish");
}

/**
 * Ports a real gateway is likely to be listening on. Not a security boundary —
 * a canary for helper scripts, so an obviously-misaimed run stops before it
 * mutates the operator's live instance rather than after.
 */
export const PRODUCTION_GATEWAY_PORTS = [8888] as const;

export interface ProductionGatewayCheck {
  home?: string;
  port?: number | string;
  url?: string;
  homedir?: string;
}

/**
 * Describe why a target looks like the operator's live instance, or null when
 * it does not.
 *
 * Deliberately advisory and deliberately loud: it exists so a destructive
 * helper says "this is your real gateway" instead of proceeding.
 */
export function describeProductionGatewayTarget(check: ProductionGatewayCheck): string | null {
  const reasons: string[] = [];

  if (check.home) {
    const resolved = path.resolve(check.home);
    if (resolved === defaultInstanceHome(check.homedir)) {
      reasons.push(`home ${resolved} is the default instance home`);
    }
  }

  const port = check.port === undefined ? undefined : Number(check.port);
  if (port !== undefined && Number.isFinite(port) && (PRODUCTION_GATEWAY_PORTS as readonly number[]).includes(port)) {
    reasons.push(`port ${port} is a default gateway port`);
  }

  if (check.url) {
    try {
      const parsed = new URL(check.url);
      const urlPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
      if ((PRODUCTION_GATEWAY_PORTS as readonly number[]).includes(urlPort) && !reasons.some((r) => r.startsWith("port "))) {
        reasons.push(`url ${check.url} targets a default gateway port`);
      }
    } catch {
      // An unparseable URL is the caller's problem, not this canary's.
    }
  }

  return reasons.length > 0 ? reasons.join("; ") : null;
}

/**
 * Throw when `check` names what looks like the operator's live instance.
 *
 * `allowOverride` is the deliberate escape hatch for someone who really does
 * mean to point a helper at their own gateway.
 */
export function assertNotProductionGateway(check: ProductionGatewayCheck, allowOverride = false): void {
  if (allowOverride) return;
  const reason = describeProductionGatewayTarget(check);
  if (!reason) return;
  throw new Error(
    `Refusing to run against what looks like your live Cuttlefish instance (${reason}). ` +
    "Point this at a sandbox instance, or set CUTTLEFISH_ALLOW_PRODUCTION_TARGET=1 if you really mean it.",
  );
}
