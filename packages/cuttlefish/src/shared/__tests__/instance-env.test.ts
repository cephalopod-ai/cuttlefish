import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTANCE_IDENTITY_ENV_VARS,
  assertNotProductionGateway,
  defaultInstanceHome,
  describeProductionGatewayTarget,
  scrubInstanceIdentityEnv,
  withoutInstanceIdentityEnv,
} from "../instance-env.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("instance-identity env list (UPS-A9)", () => {
  it("covers the variables that name which instance a process belongs to", () => {
    for (const key of ["CUTTLEFISH_HOME", "CUTTLEFISH_INSTANCE", "CUTTLEFISH_GATEWAY_URL", "CUTTLEFISH_GATEWAY_TOKEN"]) {
      expect(INSTANCE_IDENTITY_ENV_VARS).toContain(key);
    }
  });

  it("stays identical to the copy vitest.setup.ts carries", () => {
    // The setup file cannot import this module (its imports are instantiated
    // before every test module, which would cache paths against the real
    // node:os); this test is what keeps the two lists from drifting.
    const setup = fs.readFileSync(path.join(packageRoot, "vitest.setup.ts"), "utf-8");
    const block = setup.match(/const INSTANCE_IDENTITY_ENV_VARS = \[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const setupVars = Array.from(block![1].matchAll(/"([^"]+)"/g), (m) => m[1]);
    expect(setupVars).toEqual([...INSTANCE_IDENTITY_ENV_VARS]);
  });

  it("actually scrubbed the worker environment this test is running in", () => {
    for (const key of INSTANCE_IDENTITY_ENV_VARS) {
      // CUTTLEFISH_HOME is legitimately re-set by the temp-home test helpers,
      // so only assert on the ones nothing re-sets.
      if (key === "CUTTLEFISH_HOME") continue;
      expect(process.env[key]).toBeUndefined();
    }
  });
});

describe("withoutInstanceIdentityEnv / scrubInstanceIdentityEnv", () => {
  it("removes every identity variable and leaves everything else", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/me", CUTTLEFISH_HOME: "/home/me/.cuttlefish", CUTTLEFISH_PORT: "8888" };
    const cleaned = withoutInstanceIdentityEnv(env);
    expect(cleaned).toEqual({ PATH: "/usr/bin", HOME: "/home/me" });
    // The source object is untouched.
    expect(env.CUTTLEFISH_HOME).toBe("/home/me/.cuttlefish");
  });

  it("reports what it removed when scrubbing in place", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", CUTTLEFISH_GATEWAY_TOKEN: "t" };
    expect(scrubInstanceIdentityEnv(env)).toEqual(["CUTTLEFISH_GATEWAY_TOKEN"]);
    expect(env).toEqual({ PATH: "/usr/bin" });
    // Idempotent.
    expect(scrubInstanceIdentityEnv(env)).toEqual([]);
  });
});

describe("production-gateway canary (UPS-A9)", () => {
  const homedir = "/home/me";

  it("recognises the default instance home", () => {
    expect(describeProductionGatewayTarget({ home: defaultInstanceHome(homedir), homedir })).toContain("default instance home");
    expect(describeProductionGatewayTarget({ home: "/tmp/sandbox-home", homedir })).toBeNull();
  });

  it("recognises a default gateway port, given directly or in a URL", () => {
    expect(describeProductionGatewayTarget({ port: 8888 })).toContain("default gateway port");
    expect(describeProductionGatewayTarget({ port: "8888" })).toContain("default gateway port");
    expect(describeProductionGatewayTarget({ url: "http://127.0.0.1:8888" })).toContain("default gateway port");
    expect(describeProductionGatewayTarget({ port: 9123 })).toBeNull();
    expect(describeProductionGatewayTarget({ url: "http://127.0.0.1:9123" })).toBeNull();
  });

  it("does not choke on an unparseable URL", () => {
    expect(describeProductionGatewayTarget({ url: "not a url" })).toBeNull();
  });

  it("throws with an actionable message, and honours the explicit override", () => {
    expect(() => assertNotProductionGateway({ port: 8888 })).toThrow(/live Cuttlefish instance/);
    expect(() => assertNotProductionGateway({ port: 8888 })).toThrow(/CUTTLEFISH_ALLOW_PRODUCTION_TARGET/);
    expect(() => assertNotProductionGateway({ port: 8888 }, true)).not.toThrow();
    expect(() => assertNotProductionGateway({ port: 9123 })).not.toThrow();
  });

  it("defaults the home to the real homedir when none is given", () => {
    expect(defaultInstanceHome()).toBe(path.join(os.homedir(), ".cuttlefish"));
  });
});

describe("orchestration-smoke script carries the canary (UPS-A9)", () => {
  it("refuses a default home or port unless the override is set", () => {
    const script = fs.readFileSync(path.resolve(packageRoot, "..", "..", "scripts", "orchestration-smoke.mjs"), "utf-8");
    expect(script).toContain("CUTTLEFISH_ALLOW_PRODUCTION_TARGET");
    expect(script).toContain("refuseProductionTarget");
    expect(script).toContain("default instance home");
    expect(script).toContain("default gateway port");
  });
});
