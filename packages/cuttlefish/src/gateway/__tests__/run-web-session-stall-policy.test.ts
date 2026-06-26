import { describe, it, expect } from "vitest";
import { resolveTurnStallWatchdogConfig, shouldRetrySameEngineAfterStall } from "../run-web-session.js";

describe("resolveTurnStallWatchdogConfig", () => {
  it("uses the tuned defaults when the gateway block omits stall settings", () => {
    const policy = resolveTurnStallWatchdogConfig({
      gateway: { port: 8888, host: "127.0.0.1" },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.5" },
      },
      connectors: {},
      logging: { file: true, stdout: true, level: "info" },
    });

    expect(policy).toMatchObject({
      tickMs: 30_000,
      inactivityMs: 180_000,
      hardCeilingMs: 2_700_000,
      maxRetries: 1,
    });
  });

  it("accepts explicit gateway stall overrides", () => {
    const policy = resolveTurnStallWatchdogConfig({
      gateway: {
        port: 8888,
        host: "127.0.0.1",
        turnStallInactivityMs: 120_000,
        turnStallCeilingMs: 900_000,
        turnStallRetries: 2,
      },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.5" },
      },
      connectors: {},
      logging: { file: true, stdout: true, level: "info" },
    });

    expect(policy).toMatchObject({
      inactivityMs: 120_000,
      hardCeilingMs: 900_000,
      maxRetries: 2,
    });
  });
});

describe("shouldRetrySameEngineAfterStall", () => {
  it("allows one same-engine retry when maxRetries is 1", () => {
    expect(shouldRetrySameEngineAfterStall(0, 1)).toBe(true);
    expect(shouldRetrySameEngineAfterStall(1, 1)).toBe(false);
  });

  it("supports immediate fallback when maxRetries is 0", () => {
    expect(shouldRetrySameEngineAfterStall(0, 0)).toBe(false);
  });
});
