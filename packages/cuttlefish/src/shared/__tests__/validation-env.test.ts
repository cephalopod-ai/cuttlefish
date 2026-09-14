import { afterEach, describe, expect, it, vi } from "vitest";
import { buildValidationEnv } from "../validation-env.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildValidationEnv", () => {
  it("carries through only the fixed allowlisted keys that are actually set", () => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("HOME", "/home/test");
    vi.stubEnv("SOME_RANDOM_UNRELATED_VAR", "should-not-appear");
    const env = buildValidationEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.SOME_RANDOM_UNRELATED_VAR).toBeUndefined();
  });

  it("never leaks a secret-shaped variable that isn't explicitly allowlisted, even if set in the parent process", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-should-not-leak");
    vi.stubEnv("TWILIO_SID", "should-not-leak-either");
    const env = buildValidationEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TWILIO_SID).toBeUndefined();
  });

  it("includes a caller-declared allowSecretKeys entry, and only that one", () => {
    vi.stubEnv("MY_REGISTRY_TOKEN", "abc123");
    vi.stubEnv("SOME_OTHER_SECRET", "xyz789");
    const env = buildValidationEnv({ allowSecretKeys: ["MY_REGISTRY_TOKEN"] });
    expect(env.MY_REGISTRY_TOKEN).toBe("abc123");
    expect(env.SOME_OTHER_SECRET).toBeUndefined();
  });

  it("applies additions on top of the allowlist", () => {
    vi.stubEnv("PATH", "/usr/bin");
    const env = buildValidationEnv({ additions: { PATH: "/custom/bin", CONTRACT_STAGE_ID: "stage-1" } });
    expect(env.PATH).toBe("/custom/bin");
    expect(env.CONTRACT_STAGE_ID).toBe("stage-1");
  });

  it("does not silently pull in an unset allowlisted key", () => {
    vi.stubEnv("TMPDIR", undefined as unknown as string);
    delete process.env.TMPDIR;
    const env = buildValidationEnv();
    expect("TMPDIR" in env).toBe(false);
  });
});
