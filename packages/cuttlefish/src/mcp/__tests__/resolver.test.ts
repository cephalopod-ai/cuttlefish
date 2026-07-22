import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexMcpConfigFlags, resolveMcpServers, sweepStaleMcpConfigFiles, writeMcpConfigFile } from "../resolver.js";
import { setCuttlefishHomeForTest } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";

describe("MCP resolver", () => {
  it("resolves browser automation to the Playwright MCP server", () => {
    const resolved = resolveMcpServers({
      browser: { enabled: true, provider: "playwright" },
    });

    expect(resolved.mcpServers.browser).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@0.0.78"],
    });
  });

  it("converts resolved MCP servers to Codex config overrides", () => {
    const flags = codexMcpConfigFlags({
      mcpServers: {
        browser: { command: "npx", args: ["-y", "@playwright/mcp@0.0.78"] },
      },
    });

    expect(flags).toEqual([
      "-c",
      'mcp_servers.browser.command="npx"',
      "-c",
      'mcp_servers.browser.args=["-y", "@playwright/mcp@0.0.78"]',
    ]);
  });

  it("pins each built-in npx package and does not launch the retired fetch package", () => {
    const resolved = resolveMcpServers({
      browser: { enabled: true, provider: "puppeteer" },
      search: { enabled: true, provider: "brave", apiKey: "brave-key" },
      fetch: { enabled: true },
    });

    expect(resolved.mcpServers.browser).toEqual({ command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer@2025.5.12"] });
    expect(resolved.mcpServers.search).toEqual({ command: "npx", args: ["-y", "brave-search-mcp@2.1.0"], env: { BRAVE_API_KEY: "brave-key" } });
    expect(resolved.mcpServers.fetch).toBeUndefined();
    for (const server of Object.values(resolved.mcpServers)) {
      if ("args" in server) expect(server.args?.some((arg) => arg === "@latest")).toBe(false);
    }
  });

  it("skips a malformed custom MCP server entry with a warning instead of crashing (FSR-CF-016)", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const resolved = resolveMcpServers({
        custom: {
          // Missing "command" and no "url" — not a valid stdio or URL server.
          broken: { args: ["--foo"] } as any,
          good: { command: "npx", args: ["-y", "some-mcp-package"] },
        },
      });

      expect(resolved.mcpServers.broken).toBeUndefined();
      expect(resolved.mcpServers.good).toEqual({ command: "npx", args: ["-y", "some-mcp-package"] });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"broken"'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("command"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("skips a custom MCP server entry that isn't an object with a warning", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const resolved = resolveMcpServers({
        custom: {
          broken: "not-an-object" as any,
        },
      });
      expect(resolved.mcpServers.broken).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"broken"'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resolves custom MCP env placeholders without mutating source config", () => {
    process.env.TEST_MCP_SECRET = "resolved-secret";
    try {
      const config = {
        custom: {
          private: {
            command: "node",
            args: ["server.js"],
            env: { SERVICE_KEY: "${TEST_MCP_SECRET}", SAFE_VALUE: "kept" },
          },
        },
      };

      const resolved = resolveMcpServers(config);

      expect((resolved.mcpServers.private as any).env).toEqual({ SERVICE_KEY: "resolved-secret", SAFE_VALUE: "kept" });
      expect(config.custom.private.env).toEqual({ SERVICE_KEY: "${TEST_MCP_SECRET}", SAFE_VALUE: "kept" });
    } finally {
      delete process.env.TEST_MCP_SECRET;
    }
  });

  describe("writeMcpConfigFile", () => {
    let originalHome: string | undefined;
    let tmpHome: string;

    beforeEach(() => {
      originalHome = process.env.CUTTLEFISH_HOME;
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-mcp-resolver-test-"));
      setCuttlefishHomeForTest(tmpHome);
    });

    afterEach(() => {
      if (originalHome === undefined) {
        delete process.env.CUTTLEFISH_HOME;
      }
      setCuttlefishHomeForTest(originalHome ?? tmpHome);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it("writes the resolved MCP config file with 0600 permissions (SEC-CFDB-006)", () => {
      const filePath = writeMcpConfigFile({ mcpServers: { search: { command: "npx", args: [], env: { BRAVE_API_KEY: "secret" } } } }, "session-perm-test");

      expect(fs.existsSync(filePath)).toBe(true);
      const mode = fs.statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("sweeps stale MCP config files older than the threshold while keeping fresh ones", () => {
      const freshPath = writeMcpConfigFile({ mcpServers: {} }, "fresh-session");

      const tmpDir = path.join(tmpHome, "tmp", "mcp");
      const stalePath = path.join(tmpDir, "stale-session.json");
      fs.writeFileSync(stalePath, JSON.stringify({ mcpServers: {} }));
      const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h old, past the 24h threshold
      fs.utimesSync(stalePath, staleTime, staleTime);

      const removed = sweepStaleMcpConfigFiles();

      expect(removed).toBe(1);
      expect(fs.existsSync(stalePath)).toBe(false);
      expect(fs.existsSync(freshPath)).toBe(true);
    });
  });
});
