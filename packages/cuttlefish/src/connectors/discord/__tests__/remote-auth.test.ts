import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { RemoteDiscordConnector } from "../remote.js";
import { logger } from "../../../shared/logger.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("RemoteDiscordConnector auth", () => {
  it("sends the configured gateway token and logs non-OK proxy responses", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: vi.fn(async () => "missing token"),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const connector = new RemoteDiscordConnector({
      proxyVia: "http://127.0.0.1:8888",
      apiToken: "primary-token",
    });

    const result = await connector.sendMessage({ channel: "c1" }, "hello");

    expect(result).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:8888/api/connectors/discord/proxy",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Cuttlefish-Token": "primary-token",
        }),
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("401 Unauthorized"));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("missing token"));
  });
});
