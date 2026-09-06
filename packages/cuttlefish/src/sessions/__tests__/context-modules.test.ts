import { describe, expect, it } from "vitest";
import { buildApiReference, buildApiReferenceSummary } from "../context-api.js";
import { Tier, trimContext, type Section } from "../context-budget.js";
import { buildContext } from "../context.js";
import type { Employee, CuttlefishConfig } from "../../shared/types.js";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

withStaticTempCuttlefishHome("cuttlefish-context-modules-");

const worker: Employee = {
  name: "writer", displayName: "Writer", department: "content", rank: "employee",
  engine: "claude", model: "opus", persona: "Write the requested content.",
};
const gatewayUrl = "http://127.0.0.1:8899";

function section(tier: Tier, content: string, summary = ""): Section {
  return { tier, marker: content, content, summary };
}

describe("context budget selection", () => {
  it("joins the original sections at the exact cap without mutation", () => {
    const sections = [section(Tier.STANDARD, "first", "a"), section(Tier.OPTIONAL, "last", "b")];
    const before = structuredClone(sections);
    expect(trimContext(sections, 11)).toBe("first\n\nlast");
    expect(sections).toEqual(before);
  });

  it("trims optional content before standard content even when standard is later", () => {
    expect(trimContext([
      section(Tier.OPTIONAL, "optional", "o"),
      section(Tier.STANDARD, "standard", "s"),
    ], 11)).toBe("o\n\nstandard");
  });

  it("trims from the end within a tier and stops once the cap is met", () => {
    expect(trimContext([
      section(Tier.OPTIONAL, "first", "f"),
      section(Tier.OPTIONAL, "second", "s"),
    ], 8)).toBe("first\n\ns");
  });

  it("preserves essential and unsummarizable sections even over budget", () => {
    expect(trimContext([
      section(Tier.ESSENTIAL, "essential", "e"),
      section(Tier.STANDARD, "unsummarizable"),
    ], 0)).toBe("essential\n\nunsummarizable");
  });

  it("uses both lower tiers when necessary", () => {
    expect(trimContext([
      section(Tier.ESSENTIAL, "identity"),
      section(Tier.STANDARD, "standard", "s"),
      section(Tier.OPTIONAL, "optional", "o"),
    ], 1)).toBe("identity\n\ns\n\no");
  });

  it("handles an empty section list", () => {
    expect(trimContext([], 0)).toBe("");
  });

  it("never expands a section to a longer fallback under budget pressure", () => {
    expect(trimContext([
      section(Tier.OPTIONAL, "short", "a much longer summary"),
      section(Tier.STANDARD, "standard", "s"),
    ], 1)).toBe("short\n\ns");
  });

  it("keeps the original when a fallback saves no space", () => {
    expect(trimContext([section(Tier.STANDARD, "body", "same")], 1)).toBe("body");
  });
});

describe("audience-scoped API guidance", () => {
  it.each([
    ["COO", undefined, 0, "Spawn a child session"],
    ["manager", { ...worker, rank: "manager" as const }, 0, "Delegate to another employee"],
    ["executive", { ...worker, rank: "executive" as const }, 0, "Delegate to another employee"],
    ["supervisor", worker, 1, "Delegate to another employee"],
  ])("keeps the %s child-session recipe in full and compact output", (_name, employee, reports, recipe) => {
    for (const build of [buildApiReference, buildApiReferenceSummary]) {
      const output = build(gatewayUrl, "Portal", employee, reports);
      expect(output).toContain(recipe);
      expect(output).toContain("parentSessionId");
      expect(output).toContain(`${gatewayUrl}/api/sessions/:id/message`);
      expect(output).toContain("HR accepts direct top-level human-operator requests only");
    }
  });

  it.each([worker, { ...worker, rank: "senior" as const }])("keeps delegation unavailable for $rank without reports", employee => {
    for (const build of [buildApiReference, buildApiReferenceSummary]) {
      const output = build(gatewayUrl, "Portal", employee);
      expect(output).toContain("Child-session delegation is unavailable");
      expect(output).not.toContain("POST http://127.0.0.1:8899/api/sessions`");
    }
  });

  it("uses the injected credential without rendering its value", () => {
    const output = buildApiReference(gatewayUrl, "Portal", worker, 0, "test-secret");
    expect(output).toContain("$CUTTLEFISH_SESSION_TOKEN");
    expect(output).not.toContain("test-secret");
    expect(output).toContain("Never call an approve, reject, or apply endpoint");
    expect(output).toContain("/api/checkpoints");
    expect(output).toContain("/attachments");
  });

  it("propagates explicit delegated decisions without granting direct org apply", () => {
    const output = buildApiReference(gatewayUrl, "Portal", undefined, 0, "test-secret", ["decide"]);
    expect(output).toContain("explicit human-delegated decision authority");
    expect(output).toContain("Direct org apply routes remain operator-only");
    expect(output).not.toContain("Never call an approve, reject, or apply endpoint");
  });

  it.each([undefined, worker, { ...worker, rank: "manager" as const }])("keeps action guidance when compacting for $rank", employee => {
    const output = buildApiReferenceSummary(gatewayUrl, "Portal", employee, 0, "test-secret");
    expect(output).toContain("$CUTTLEFISH_SESSION_TOKEN");
    expect(output).not.toContain("test-secret");
    expect(output).toContain("/api/checkpoints");
    expect(output).toContain("decisionNeeded");
    expect(output).toContain("/attachments");
    expect(output).toContain("Never call an approve, reject, or apply endpoint");
  });

  it.each(["approve", "decide"] as const)("keeps delegated %s authority in the compact variant", scope => {
    const output = buildApiReferenceSummary(gatewayUrl, "Portal", undefined, 0, "test-secret", [scope]);
    expect(output).toContain("explicit human-delegated decision authority");
    expect(output).toContain("Direct org apply routes remain operator-only");
    expect(output).not.toContain("Never call an approve, reject, or apply endpoint");
  });

  it("keeps compact decision guidance usable without a scoped token", () => {
    const output = buildApiReferenceSummary(gatewayUrl, "Portal", worker);
    expect(output).toContain("/api/checkpoints");
    expect(output).toContain("local gateway auth");
    expect(output).not.toContain("$CUTTLEFISH_SESSION_TOKEN");
  });

  it("does not promote plan/act scopes into decision authority", () => {
    for (const build of [buildApiReference, buildApiReferenceSummary]) {
      const output = build(gatewayUrl, "Portal", undefined, 0, "test-secret", ["plan", "act"]);
      expect(output).toContain("Never call an approve, reject, or apply endpoint");
      expect(output).not.toContain("explicit human-delegated decision authority");
    }
  });
});

describe("compact API guidance through the context facade", () => {
  it.each([undefined, worker, { ...worker, rank: "manager" as const }])("retains compact action guidance and essential context for $rank", employee => {
    const config = {
      gateway: { host: "127.0.0.1", port: 8899 }, engines: { default: "claude" },
      portal: { setupComplete: true, portalName: "Portal" }, context: { maxChars: 1 },
    } as CuttlefishConfig;
    for (const scopes of [[], ["decide"]] as const) {
      const opts = {
        source: "web", channel: "web", user: "operator", employee, config,
        sessionId: "session-fixture", sessionToken: "test-secret",
        operatorDelegationScopes: [...scopes],
      };
      const output = buildContext(opts);
      expect(output).toContain(buildApiReferenceSummary(gatewayUrl, "Portal", employee, 0, "test-secret", [...scopes]));
      expect(output).toContain("Session ID: session-fixture");
      expect(output).not.toContain("test-secret");
      if (scopes.length) expect(output).toContain("## Human-delegated authority");
      const untrimmed = buildContext({ ...opts, config: { ...config, context: { maxChars: 100_000 } } });
      expect(output.length).toBeLessThan(untrimmed.length);
    }
  });
});
