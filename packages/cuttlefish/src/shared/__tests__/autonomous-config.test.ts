/**
 * Config-schema guards for autonomous authorization mode. The two invariants
 * here are load-bearing safety properties from the feature's design:
 *   1. autonomousMode.enabled requires a non-empty profile cwd (an unbounded
 *      autonomous project defeats "scoped to one project" entirely);
 *   2. at MOST one workspace profile may enable it — enforced at config load,
 *      so a copy-pasted profile block cannot silently widen the blast radius.
 */
import { describe, it, expect } from "vitest";
import { validateConfigShape } from "../config-schema.js";

const base = {
  gateway: { port: 8888, host: "127.0.0.1" },
  engines: { claude: { bin: "claude", model: "opus" } },
  logging: { file: true, stdout: true, level: "info" },
};

function withProfiles(profiles: Record<string, unknown>, features?: Record<string, unknown>): Record<string, unknown> {
  return { ...base, ...(features ? { features } : {}), workspaces: { profiles } };
}

describe("autonomousMode config validation", () => {
  it("accepts a single enabled profile with a cwd, plus the global feature flag", () => {
    expect(
      validateConfigShape(
        withProfiles(
          {
            demo: {
              label: "Demo",
              cwd: "/tmp/project",
              autonomousMode: {
                enabled: true,
                toolReview: true,
                orgChangeOverride: false,
                continuousDispatch: true,
                maxAutoDispatchesPerHour: 6,
              },
            },
          },
          { autonomousMode: true },
        ),
      ),
    ).toEqual([]);
  });

  it("rejects autonomousMode.enabled without a profile cwd", () => {
    const problems = validateConfigShape(
      withProfiles({ demo: { label: "Demo", autonomousMode: { enabled: true } } }),
    );
    expect(problems.some((p) => p.includes("cwd is required when autonomousMode.enabled is true"))).toBe(true);
  });

  it("rejects a config where TWO profiles enable autonomousMode (singleton invariant)", () => {
    const problems = validateConfigShape(
      withProfiles({
        a: { cwd: "/tmp/a", autonomousMode: { enabled: true } },
        b: { cwd: "/tmp/b", autonomousMode: { enabled: true } },
      }),
    );
    expect(problems.some((p) => p.includes("at most one profile may have autonomousMode.enabled true"))).toBe(true);
  });

  it("accepts two profiles when only one is enabled", () => {
    expect(
      validateConfigShape(
        withProfiles({
          a: { cwd: "/tmp/a", autonomousMode: { enabled: true } },
          b: { cwd: "/tmp/b", autonomousMode: { enabled: false } },
        }),
      ),
    ).toEqual([]);
  });

  it("rejects unknown keys and non-boolean flags inside the autonomousMode block", () => {
    const unknownKey = validateConfigShape(
      withProfiles({ demo: { cwd: "/tmp/p", autonomousMode: { enabled: true, surprise: true } } }),
    );
    expect(unknownKey.some((p) => p.includes("surprise"))).toBe(true);

    const badType = validateConfigShape(
      withProfiles({ demo: { cwd: "/tmp/p", autonomousMode: { enabled: true, toolReview: "yes" } } }),
    );
    expect(badType.some((p) => p.includes("toolReview"))).toBe(true);
  });

  it("rejects a non-boolean global features.autonomousMode", () => {
    const problems = validateConfigShape({ ...base, features: { autonomousMode: "on" } });
    expect(problems.some((p) => p.includes("features.autonomousMode"))).toBe(true);
  });
});
