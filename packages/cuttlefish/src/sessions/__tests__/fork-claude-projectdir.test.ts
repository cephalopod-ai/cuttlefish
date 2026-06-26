import { describe, it, expect, vi } from "vitest";
import path from "node:path";

/**
 * Regression test for claudeProjectDir() in ../fork.ts.
 *
 * Claude Code slugifies a cwd into its transcript directory by replacing every
 * "/" AND "." with "-". A buggy version replaced only "/", so a cwd like
 * `~/.cuttlefish` mapped to `-Users-…-.cuttlefish` instead of the real `-Users-…--cuttlefish`
 * (double dash). The interactive fork then polled a non-existent directory and
 * timed out after 60s — breaking the Duplicate feature for every session whose
 * cwd contains a dot (i.e. every COO/.cuttlefish session). This locks in the correct
 * slug, matching findTranscriptForSession() in claude-interactive.ts.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: { ...actual, homedir: () => "/home/test" },
    homedir: () => "/home/test",
  };
});

import { buildClaudeForkEnv, claudeProjectDir } from "../fork.js";

describe("claudeProjectDir", () => {
  const base = path.join("/home/test", ".claude", "projects");

  it("replaces both '/' and '.' with '-' for a dotted cwd (~/.cuttlefish → --cuttlefish)", () => {
    expect(claudeProjectDir("/Users/x/.cuttlefish")).toBe(path.join(base, "-Users-x--cuttlefish"));
  });

  it("handles a normal dotless cwd", () => {
    expect(claudeProjectDir("/Users/x/Projects/cuttlefish")).toBe(
      path.join(base, "-Users-x-Projects-cuttlefish"),
    );
  });

  it("handles multiple dotted segments", () => {
    expect(claudeProjectDir("/Users/x/.config/.app")).toBe(
      path.join(base, "-Users-x--config--app"),
    );
  });

  it("replaces every non-alphanumeric char (spaces, underscores, unicode)", () => {
    expect(claudeProjectDir("/Users/x/My Projects/app_v2 (béta)")).toBe(
      path.join(base, "-Users-x-My-Projects-app-v2--b-ta-"),
    );
  });
});

describe("buildClaudeForkEnv", () => {
  it("strips Claude gateway hooks and Anthropic tokens from fork processes", () => {
    const prevClaudeCode = process.env.CLAUDE_CODE_SESSION;
    const prevClaudeCodeBare = process.env.CLAUDECODE;
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      process.env.CLAUDE_CODE_SESSION = "hook-session";
      process.env.CLAUDECODE = "1";
      process.env.ANTHROPIC_AUTH_TOKEN = "anthropic-token";

      const env = buildClaudeForkEnv({ CLAUDE_CODE_NO_FLICKER: "1" });

      expect(env.CLAUDE_CODE_SESSION).toBeUndefined();
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_NO_FLICKER).toBe("1");
    } finally {
      if (prevClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION;
      else process.env.CLAUDE_CODE_SESSION = prevClaudeCode;
      if (prevClaudeCodeBare === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = prevClaudeCodeBare;
      if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
    }
  });
});
