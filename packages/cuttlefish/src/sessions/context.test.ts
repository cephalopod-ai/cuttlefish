import { test, expect } from "vitest";
import { buildIdentity } from "./context.js";

test("identity addresses the operator in second person, not third", () => {
  const text = buildIdentity("Hui", "John", "English");
  expect(text).toContain("You are Hui");
  expect(text).toMatch(/speaking with .*John|talking with .*John|with \*\*John\*\*/);
  expect(text).toMatch(/second person/i);
  // No third-person "report to John (CEO)" framing that caused "I help John".
  expect(text).not.toMatch(/report to \*\*John\*\* \(CEO\)/);
});

test("identity adds a language directive only for non-English", () => {
  expect(buildIdentity("Hui", "John", "Spanish")).toMatch(/respond in Spanish/i);
  expect(buildIdentity("Hui", "John", "English")).not.toMatch(/respond in English/i);
});

import { buildOnboardingContext } from "./context.js";

test("onboarding context is null once onboarded", () => {
  expect(buildOnboardingContext({ portalName: "Hui", operatorName: "John", setupComplete: true })).toBeNull();
});

test("onboarding context greets by name and forbids re-asking it", () => {
  const text = buildOnboardingContext({ portalName: "Hui", operatorName: "John", setupComplete: false })!;
  expect(text).toContain("John");
  expect(text).toMatch(/already know|do not ask.*name|don't ask.*name/i);
  expect(text).toMatch(/onboarding/); // points at the skill
});
