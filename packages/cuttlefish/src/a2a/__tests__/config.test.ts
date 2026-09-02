import { describe, expect, it } from "vitest";
import { validateA2A } from "../../shared/config-schema-a2a.js";

function problems(value: unknown): string[] {
  const result: string[] = [];
  validateA2A(result, value);
  return result;
}

describe("A2A configuration", () => {
  it("accepts an explicit allowlist and per-client credentials", () => {
    expect(problems({
      enabled: true,
      publicUrl: "https://gateway.example/a2a",
      allowedServices: ["code review"],
      clients: [{ id: "partner-a", token: "0123456789abcdef", allowedServices: ["code review"] }],
      maxInputBytes: 65_536,
      maxArtifactBytes: 10_485_760,
      pollIntervalMs: 250,
    })).toEqual([]);
  });

  it("requires allowlisted services and authenticated callers when enabled", () => {
    expect(problems({ enabled: true })).toEqual(expect.arrayContaining([
      "a2a.allowedServices must contain at least one service when A2A is enabled",
      "a2a.clients must contain at least one authenticated caller when A2A is enabled",
    ]));
  });

  it("rejects duplicate identities, duplicate credentials, and weak credentials", () => {
    const result = problems({
      clients: [
        { id: "partner", token: "too-short" },
        { id: "partner", token: "too-short" },
      ],
    });
    expect(result).toEqual(expect.arrayContaining([
      "a2a.clients[0].token must contain at least 16 characters",
      "a2a.clients[1].id duplicates another A2A client id",
      "a2a.clients[1].token duplicates another A2A client token",
    ]));
  });

  it("accepts an outbound peer only with explicit skills and origin controls", () => {
    expect(problems({
      destinations: [{
        id: "mada-local",
        agentCardUrl: "http://127.0.0.1:9999/.well-known/agent-card.json",
        token: "0123456789abcdef",
        credentialType: "x-api-key",
        allowedSkills: ["review-code"],
        services: [{ name: "external-review", description: "Review through MADA", skillId: "review-code" }],
        allowedOrigins: ["http://127.0.0.1:9999"],
        allowPrivateHosts: true,
        timeoutMs: 30_000,
      }],
    })).toEqual([]);
  });

  it("rejects external service mappings that escape the destination skill allowlist", () => {
    expect(problems({
      destinations: [{
        id: "peer",
        agentCardUrl: "https://peer.example/card",
        token: "0123456789abcdef",
        allowedSkills: ["review-code"],
        services: [{ name: "external-admin", description: "No", skillId: "admin" }],
        timeoutMs: 999,
      }],
    })).toEqual(expect.arrayContaining([
      "a2a.destinations[0].services[0].skillId must also appear in a2a.destinations[0].allowedSkills",
      "a2a.destinations[0].timeoutMs must be between 1000 and 600000",
    ]));
  });

  it("rejects arbitrary outbound credential types", () => {
    expect(problems({
      destinations: [{
        id: "peer",
        agentCardUrl: "https://peer.example/card",
        token: "0123456789abcdef",
        credentialType: "cookie",
        allowedSkills: ["review-code"],
      }],
    })).toContain("a2a.destinations[0].credentialType must be bearer or x-api-key");
  });

  it("rejects cleartext credential transport outside explicit local development", () => {
    expect(problems({
      destinations: [{
        id: "peer",
        agentCardUrl: "http://peer.example/card",
        token: "0123456789abcdef",
        allowedSkills: ["review-code"],
        allowedOrigins: ["http://peer.example"],
      }],
    })).toEqual(expect.arrayContaining([
      "a2a.destinations[0].agentCardUrl must use https except for an explicitly enabled local-development HTTP peer",
      "a2a.destinations[0].allowedOrigins[0] must use https except for an explicitly enabled local-development HTTP peer",
    ]));
  });

  it("rejects path-bearing origin allowlist entries and outbound peers without skills", () => {
    expect(problems({
      destinations: [{
        id: "peer",
        agentCardUrl: "https://peer.example/card",
        token: "0123456789abcdef",
        allowedSkills: [],
        allowedOrigins: ["https://peer.example/a2a"],
      }],
    })).toEqual(expect.arrayContaining([
      "a2a.destinations[0].allowedSkills must contain at least one remote skill id",
      "a2a.destinations[0].allowedOrigins[0] must be an exact http(s) origin without a path",
    ]));
  });

  it("rejects credentials in the public URL and duplicate service mappings across peers", () => {
    expect(problems({
      publicUrl: "https://user:secret@gateway.example/a2a",
      destinations: [
        {
          id: "peer-a",
          agentCardUrl: "https://a.example/card",
          token: "0123456789abcdef",
          allowedSkills: ["review"],
          services: [{ name: "external-review", description: "First", skillId: "review" }],
        },
        {
          id: "peer-b",
          agentCardUrl: "https://b.example/card",
          token: "fedcba9876543210",
          allowedSkills: ["review"],
          services: [{ name: "EXTERNAL-REVIEW", description: "Second", skillId: "review" }],
        },
      ],
    })).toEqual(expect.arrayContaining([
      "a2a.publicUrl must not contain credentials",
      "a2a.destinations[1].services[0].name duplicates another external A2A service",
    ]));
  });
});
