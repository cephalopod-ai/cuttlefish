import { test, expect } from "vitest";
import { onboardingNeeded, applyEngineChoice } from "./onboarding-policy.js";

test("onboarding is needed when not onboarded, regardless of seeded employee/sessions", () => {
  expect(onboardingNeeded(false)).toBe(true);
});

test("onboarding is not needed once onboarded flag is set", () => {
  expect(onboardingNeeded(true)).toBe(false);
});

test("applyEngineChoice sets default + per-engine model/effort", () => {
  const base: { engines: Record<string, any> } = { engines: { default: "claude", claude: { model: "opus" } } };
  const out = applyEngineChoice(base, { engine: "claude", model: "sonnet", effortLevel: "low" });
  expect(out.engines.default).toBe("claude");
  expect(out.engines.claude.model).toBe("sonnet");
  expect(out.engines.claude.effortLevel).toBe("low");
});

test("applyEngineChoice returns config unchanged when no engine provided", () => {
  const base: { engines: Record<string, any> } = { engines: { default: "claude", claude: { model: "opus" } } };
  const out = applyEngineChoice(base, {});
  expect(out).toBe(base);
});

test("applyEngineChoice preserves existing per-engine fields not in the choice", () => {
  const base: { engines: Record<string, any> } = { engines: { default: "claude", claude: { model: "opus", someOtherField: "kept" } } };
  const out = applyEngineChoice(base, { engine: "claude", model: "sonnet" });
  expect(out.engines.claude.someOtherField).toBe("kept");
  expect(out.engines.claude.model).toBe("sonnet");
  expect(out.engines.claude.effortLevel).toBeUndefined();
});
