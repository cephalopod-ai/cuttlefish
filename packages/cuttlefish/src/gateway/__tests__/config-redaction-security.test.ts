import { describe, expect, it } from "vitest";
import { isSensitiveConfigKey, sanitizeConfigForApi } from "../api.js";

describe("GET /api/config redaction", () => {
  it("recognizes common secret-bearing key names", () => {
    expect(isSensitiveConfigKey("token")).toBe(true);
    expect(isSensitiveConfigKey("botToken")).toBe(true);
    expect(isSensitiveConfigKey("api_key")).toBe(true);
    expect(isSensitiveConfigKey("OPENAI_API_KEY")).toBe(true);
    expect(isSensitiveConfigKey("clientSecret")).toBe(true);
    expect(isSensitiveConfigKey("private-key")).toBe(true);
    expect(isSensitiveConfigKey("model")).toBe(false);
  });

  it("recursively redacts connector, engine, MCP, and remote secrets", () => {
    const sanitized = sanitizeConfigForApi({
      gateway: { port: 8888 },
      engines: {
        claude: { model: "opus", apiKey: "sk-claude" },
      },
      connectors: {
        slack: { botToken: "xoxb-secret", signingSecret: "signing-secret" },
      },
      mcp: {
        servers: {
          search: { env: { BRAVE_API_KEY: "brave-secret", SAFE_VALUE: "kept" } },
        },
      },
      remotes: [{ id: "dev", token: "remote-secret", url: "http://127.0.0.1:8888" }],
    });

    expect(sanitized.engines.claude.apiKey).toBe("***");
    expect(sanitized.connectors.slack.botToken).toBe("***");
    expect(sanitized.connectors.slack.signingSecret).toBe("***");
    expect(sanitized.mcp.servers.search.env.BRAVE_API_KEY).toBe("***");
    expect(sanitized.mcp.servers.search.env.SAFE_VALUE).toBe("kept");
    expect(sanitized.remotes[0].token).toBe("***");
    expect(sanitized.remotes[0].url).toBe("http://127.0.0.1:8888");
  });
});
