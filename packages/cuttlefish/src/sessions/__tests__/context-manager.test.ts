import { afterEach, describe, expect, it } from "vitest";
import type { CuttlefishConfig } from "../../shared/types.js";
import { buildContextPacket, contextManagerMode, selectContextMessages } from "../context-manager/index.js";

function config(overrides: Partial<CuttlefishConfig> = {}): CuttlefishConfig {
  return {
    gateway: { host: "127.0.0.1", port: 8888 },
    engines: { default: "claude", claude: { model: "sonnet" }, ollama: { model: "gemma4" } },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
    ...overrides,
  } as CuttlefishConfig;
}

afterEach(() => {
  delete process.env.CUTTLEFISH_CONTEXT_MANAGER;
});

describe("contextManagerMode", () => {
  it("defaults to off", () => {
    expect(contextManagerMode(config())).toBe("off");
  });

  it("reads config mode", () => {
    expect(contextManagerMode(config({ context: { managerMode: "shadow" } }))).toBe("shadow");
    expect(contextManagerMode(config({ context: { managerMode: "on" } }))).toBe("on");
  });

  it("lets the env override config and treats invalid env as off", () => {
    process.env.CUTTLEFISH_CONTEXT_MANAGER = "shadow";
    expect(contextManagerMode(config({ context: { managerMode: "on" } }))).toBe("shadow");
    process.env.CUTTLEFISH_CONTEXT_MANAGER = "bogus";
    expect(contextManagerMode(config({ context: { managerMode: "on" } }))).toBe("off");
  });
});

describe("selectContextMessages", () => {
  it("preserves latest user prompt and most recent assistant under pressure", () => {
    const result = selectContextMessages({
      systemPrompt: "system",
      prompt: "latest ask",
      availableInputTokens: 80,
      historyMessages: [
        { role: "user", content: "old ask " + "x".repeat(400), timestamp: 1 },
        { role: "assistant", content: "old answer " + "y".repeat(400), timestamp: 2 },
        { role: "user", content: "latest ask", timestamp: 3 },
        { role: "assistant", content: "latest answer", timestamp: 4 },
      ],
    });

    expect(result.messages.map((message) => message.content)).toContain("latest ask");
    expect(result.messages.map((message) => message.content)).toContain("latest answer");
  });

  it("drops duplicate low-value rows and emits an extractive older-message summary when over budget", () => {
    const repeated = "Used shell\n" + "same output ".repeat(100);
    const result = selectContextMessages({
      systemPrompt: "system",
      prompt: "finish",
      availableInputTokens: 90,
      historyMessages: [
        { role: "assistant", content: repeated, timestamp: 1 },
        { role: "assistant", content: repeated, timestamp: 2 },
        { role: "user", content: "finish", timestamp: 3 },
        { role: "assistant", content: "current result", timestamp: 4 },
      ],
    });

    expect(result.dropped.some((drop) => drop.reason === "duplicate_low_value")).toBe(true);
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toContain("Older conversation omitted by context manager");
    expect(result.summarized.some((summary) => summary.reason === "older_messages_extract")).toBe(true);
  });

  it("truncates long older tool-like output but not latest user prompt", () => {
    const latestPrompt = "latest " + "z".repeat(200);
    const result = selectContextMessages({
      systemPrompt: "system",
      prompt: latestPrompt,
      availableInputTokens: 1_500,
      historyMessages: [
        { role: "assistant", content: "tool output " + "x".repeat(6000), timestamp: 1, toolCall: "bash" },
        { role: "user", content: "older follow-up", timestamp: 2 },
        { role: "assistant", content: "latest answer", timestamp: 3 },
        { role: "user", content: latestPrompt, timestamp: 4 },
      ],
    });

    expect(result.messages.some((message) => message.content.includes("[truncated by context manager]"))).toBe(true);
    expect(result.messages.some((message) => message.role === "user" && message.content === latestPrompt)).toBe(true);
  });
});

describe("buildContextPacket", () => {
  it("shadow mode reports metadata without managed history", () => {
    const packet = buildContextPacket({
      config: config({ context: { managerMode: "shadow" } }),
      engine: "ollama",
      model: "gemma4",
      systemPrompt: "system",
      prompt: "ask",
      historyMessages: [{ role: "user", content: "ask", timestamp: 1 }],
    });

    expect(packet.historyMessages).toBeUndefined();
    expect(packet.prompt).toBe("ask");
    expect(packet.systemPrompt).toBe("system");
    expect(packet.metadata.mode).toBe("shadow");
    expect(packet.metadata.retrievedMemory).toEqual({ enabled: false, estimatedTokens: 0 });
  });

  it("on mode manages synthetic-history engines", () => {
    const packet = buildContextPacket({
      config: config({ context: { managerMode: "on" } }),
      engine: "ollama",
      model: "gemma4",
      systemPrompt: "system",
      prompt: "ask",
      historyMessages: [{ role: "user", content: "ask", timestamp: 1 }],
    });

    expect(packet.historyMessages).toEqual([{ role: "user", content: "ask", timestamp: 1 }]);
    expect(packet.metadata.strategy).toBe("synthetic_history_managed");
  });

  it("on mode leaves native-resume engines unmodified", () => {
    const packet = buildContextPacket({
      config: config({ context: { managerMode: "on" } }),
      engine: "claude",
      model: "sonnet",
      systemPrompt: "system",
      prompt: "ask",
      historyMessages: [{ role: "user", content: "ask", timestamp: 1 }],
    });

    expect(packet.historyMessages).toBeUndefined();
    expect(packet.metadata.strategy).toBe("native_resume_unmodified");
  });
});
