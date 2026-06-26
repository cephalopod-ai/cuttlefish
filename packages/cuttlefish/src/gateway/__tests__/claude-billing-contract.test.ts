import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Claude billing path contract", () => {
  it("keeps work-turn routing bound to the interactive PTY engine", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/gateway/server.ts"), "utf-8");

    expect(source).toMatch(/const interactiveClaudeEngine = new InteractiveClaudeEngine/);
    expect(source).toMatch(/engines\.set\("claude", interactiveClaudeEngine\)/);
    expect(source).not.toMatch(/engines\.set\("claude",\s*new\s+\w*Claude\w*Engine/);
  });
});
