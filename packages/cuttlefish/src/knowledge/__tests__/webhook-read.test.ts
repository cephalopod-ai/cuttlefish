import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhookKnowledgeReadProvider } from "../read/webhook.js";

describe("WebhookKnowledgeReadProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a bounded search response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }))));
    const provider = new WebhookKnowledgeReadProvider({
      url: "http://127.0.0.1:9999/search",
      timeoutMs: 1000,
    });

    await expect(provider.search({ query: "needle", limit: 5 })).resolves.toEqual({ results: [] });
  });

  it("rejects an oversized successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(2 * 1024 * 1024 + 1))));
    const provider = new WebhookKnowledgeReadProvider({
      url: "http://127.0.0.1:9999/search",
      timeoutMs: 1000,
    });

    await expect(provider.search({ query: "needle", limit: 5 })).rejects.toThrow(/exceeded 2097152 bytes/);
  });
});
