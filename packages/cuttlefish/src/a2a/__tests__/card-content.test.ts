import { describe, expect, it } from "vitest";
import { Role, type Message } from "@a2a-js/sdk";
import type { CuttlefishConfig, Employee } from "../../shared/types.js";
import { a2aSkillId, buildA2AAgentCard, listAdvertisedA2AServices } from "../card.js";
import { extractA2APrompt, hashA2AInput, parseA2AInput, resolveA2AService } from "../content.js";
import { resolveMappedA2AService } from "../executor.js";
import { a2aArtifactFromFileMeta } from "../task-mapper.js";

const employee = (name: string, active: boolean, service: string): Employee => ({
  name,
  displayName: name,
  department: "Engineering",
  rank: "employee",
  engine: "codex",
  model: "gpt-5.6-sol",
  persona: "test",
  status: active ? "active" : "inactive",
  provides: [{ name: service, description: `Provides ${service}` }],
} as Employee);

const config = {
  cuttlefish: { version: "1.2.3" },
  gateway: { host: "127.0.0.1", port: 8888 },
  a2a: { enabled: true, publicUrl: "https://gateway.example/a2a", allowedServices: ["Code Review"] },
} as CuttlefishConfig;

function message(parts: Message["parts"], metadata: Message["metadata"] = {}): Message {
  return {
    messageId: "message-1",
    taskId: "",
    contextId: "",
    role: Role.ROLE_USER,
    parts,
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

describe("A2A discovery and content boundary", () => {
  it("publishes only active, explicitly allowlisted organization services", () => {
    const registry = new Map([
      ["reviewer", employee("reviewer", true, "Code Review")],
      ["writer", employee("writer", true, "Documentation")],
      ["retired", employee("retired", false, "Code Review")],
    ]);
    const services = listAdvertisedA2AServices(config, registry);
    expect(services).toEqual([{ name: "Code Review", description: "Provides Code Review", skillId: a2aSkillId("Code Review") }]);
    const card = buildA2AAgentCard(config, registry);
    expect(card.supportedInterfaces).toEqual([{ url: "https://gateway.example/a2a", protocolBinding: "HTTP+JSON", protocolVersion: "1.0", tenant: "" }]);
    expect(JSON.stringify(card)).not.toContain("reviewer");
    expect(JSON.stringify(card)).not.toContain("partner");
  });

  it("accepts bounded text and structured data and resolves a declared skill", () => {
    const input = message([
      { content: { $case: "text", value: "Review this" }, mediaType: "text/plain", filename: "", metadata: {} },
      { content: { $case: "data", value: { severity: "high" } }, mediaType: "application/json", filename: "", metadata: {} },
    ], { skillId: a2aSkillId("Code Review") });
    expect(extractA2APrompt(input, 1024)).toBe('Review this\n\n{"severity":"high"}');
    expect(resolveA2AService(input, listAdvertisedA2AServices(config, new Map([["reviewer", employee("reviewer", true, "Code Review")]]))).name).toBe("Code Review");
    expect(hashA2AInput(input)).toHaveLength(64);
  });

  it("accepts bounded raw files and metadata-only URL references", () => {
    const parsed = parseA2AInput(message([
      { content: { $case: "raw", value: Buffer.from("file") }, mediaType: "text/plain", filename: "notes.txt", metadata: {} },
      { content: { $case: "url", value: "https://example.test/file" }, mediaType: "text/plain", filename: "", metadata: {} },
    ]), 1024, 1024);
    expect(parsed.prompt).toBe("Process the attached A2A request resources.");
    expect(parsed.rawFiles[0]).toMatchObject({ filename: "notes.txt", mediaType: "text/plain", buffer: Buffer.from("file") });
    expect(parsed.urlResources).toEqual([{ url: "https://example.test/file", access: "read_only", intendedUse: "A2A request input" }]);
  });

  it("keeps multi-service follow-ups on the task's persisted service mapping", () => {
    const available = [
      { name: "Code Review", description: "Review code", skillId: a2aSkillId("Code Review") },
      { name: "Documentation", description: "Write docs", skillId: a2aSkillId("Documentation") },
    ];
    const task = {
      id: "task-1",
      contextId: "context-1",
      status: undefined,
      artifacts: [],
      history: [],
      metadata: {
        "cuttlefish.service": "Code Review",
        "cuttlefish.skillId": a2aSkillId("Code Review"),
      },
    };

    expect(resolveMappedA2AService(message([
      { content: { $case: "text", value: "Continue" }, mediaType: "text/plain", filename: "", metadata: {} },
    ]), task, available).name).toBe("Code Review");
    expect(() => resolveMappedA2AService(message([
      { content: { $case: "text", value: "Switch" }, mediaType: "text/plain", filename: "", metadata: {} },
    ], { service: "Documentation" }), task, available)).toThrow(/cannot switch/);
  });

  it("rejects oversized decoded input and raw files", () => {
    expect(() => extractA2APrompt(message([
      { content: { $case: "text", value: "x".repeat(1025) }, mediaType: "text/plain", filename: "", metadata: {} },
    ]), 1024)).toThrow(/input limit/);
    expect(() => parseA2AInput(message([
      { content: { $case: "raw", value: Buffer.alloc(1025) }, mediaType: "application/octet-stream", filename: "large.bin", metadata: {} },
    ]), 1024, 1024)).toThrow(/decoded artifact limit/);
  });

  it("exports generated-file lineage as metadata without local paths", () => {
    const artifact = a2aArtifactFromFileMeta({
      id: "file-1",
      filename: "report.pdf",
      size: 42,
      mimetype: "application/pdf",
      path: "/private/work/report.pdf",
      sha256: "abc",
      artifactKind: "generated",
      producingRunId: "run-1",
      sourceUrl: null,
      sourcePath: "/private/source.md",
      tags: [],
      notes: null,
      createdAt: "2026-09-02T00:00:00.000Z",
    });
    expect(artifact.metadata).toEqual({ transferPolicy: "metadata-only" });
    expect(JSON.stringify(artifact)).not.toContain("/private/");
  });
});
