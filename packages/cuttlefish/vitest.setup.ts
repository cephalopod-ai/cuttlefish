/**
 * UPS-A9: scrub the instance-identity environment from every test worker.
 *
 * `pnpm test` run from a shell inside a live Cuttlefish session inherits
 * CUTTLEFISH_HOME and the gateway URL/token. Any test that does not explicitly
 * redirect the home (see `src/test-utils/cuttlefish-home.ts`) would then read —
 * and could write — the operator's real instance.
 *
 * This file deliberately imports NOTHING from `src/`. A setup file's imports are
 * instantiated before every test module, so pulling a paths-aware module in here
 * would cache it against the real `node:os` and silently disarm a later
 * `vi.mock("node:os")`. The list below is therefore a copy of
 * `INSTANCE_IDENTITY_ENV_VARS` in `src/shared/instance-env.ts`;
 * `src/shared/__tests__/instance-env.test.ts` fails if the two drift.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const INSTANCE_IDENTITY_ENV_VARS = [
  "CUTTLEFISH_HOME",
  "CUTTLEFISH_INSTANCE",
  "CUTTLEFISH_HOST",
  "CUTTLEFISH_PORT",
  "CUTTLEFISH_GATEWAY_URL",
  "CUTTLEFISH_GATEWAY_TOKEN",
  "CUTTLEFISH_SESSION_ID",
  "CUTTLEFISH_INSTANCES_REGISTRY",
  "CUTTLEFISH_BROWSER_BOOTSTRAP_TOKEN",
];

for (const key of INSTANCE_IDENTITY_ENV_VARS) {
  delete process.env[key];
}

// Removing inherited identity alone exposes the default personal-home fallback.
// Give modules without a temp-home helper a fresh state/registry destination.
const workerHome = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-vitest-worker-"));
process.env.CUTTLEFISH_HOME = workerHome;
process.env.CUTTLEFISH_INSTANCES_REGISTRY = path.join(workerHome, "instances.json");
afterAll(() => {
  fs.rmSync(workerHome, { recursive: true, force: true });
});

export { INSTANCE_IDENTITY_ENV_VARS as VITEST_SCRUBBED_INSTANCE_ENV_VARS };
