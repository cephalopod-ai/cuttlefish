import { describe, expect, it } from "vitest";
import { codexMcpConfigFlags, resolveMcpServers } from "../resolver.js";

describe("MCP resolver", () => {
  it("resolves browser automation to the Playwright MCP server", () => {
    const resolved = resolveMcpServers({
      browser: { enabled: true, provider: "playwright" },
    });

    expect(resolved.mcpServers.browser).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
    });
  });

  it("converts resolved MCP servers to Codex config overrides", () => {
    const flags = codexMcpConfigFlags({
      mcpServers: {
        browser: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      },
    });

    expect(flags).toEqual([
      "-c",
      'mcp_servers.browser.command="npx"',
      "-c",
      'mcp_servers.browser.args=["-y", "@playwright/mcp@latest"]',
    ]);
  });
});
