import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "../../../../..");
const nodeEngine = ">=24 <25";

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, rel), "utf-8")) as Record<string, unknown>;
}

function readText(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf-8");
}

describe("distribution contract", () => {
  it("uses the same bounded Node.js release in the workspace, npm package, and Homebrew formula", () => {
    const rootPackage = readJson("package.json");
    const cliPackage = readJson("packages/cuttlefish/package.json");
    const formula = readText("Formula/cuttlefish.rb");

    expect(rootPackage.engines).toEqual({ node: nodeEngine });
    expect(cliPackage.engines).toEqual({ node: nodeEngine });
    expect(formula).toContain('depends_on "node@24"');
    expect(formula).not.toMatch(/depends_on\s+"node@(?!24")/);
  });

  it("does not ship or authorize the unused classic-level native addon", () => {
    const rootPackage = readJson("package.json");
    const workspace = readText("pnpm-workspace.yaml");
    const formula = readText("Formula/cuttlefish.rb");
    const lockfile = readText("pnpm-lock.yaml");

    expect((rootPackage.dependencies as Record<string, unknown> | undefined)?.["classic-level"]).toBeUndefined();
    expect(workspace).not.toMatch(/^\s*- classic-level\s*$/m);
    expect(formula).not.toContain("classic-level");
    expect(lockfile).not.toMatch(/^\s*classic-level(?:@|:)\s*/m);
  });
});
