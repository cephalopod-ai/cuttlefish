import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("package manifest", () => {
  it("publishes the hook relay asset used by connector-backed sessions", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")) as {
      files?: string[];
      bundledDependencies?: string[];
      dependencies?: Record<string, string>;
      homepage?: string;
      repository?: { url?: string };
      bugs?: { url?: string };
    };

    expect(pkg.files).toContain("assets/");
    expect(pkg.bundledDependencies).toContain("@cuttlefish/contracts");
    expect(pkg.dependencies?.["@cuttlefish/contracts"]).toBe("0.1.0");
    expect(pkg.homepage).toBe("https://github.com/cephalopod-ai/cuttlefish#readme");
    expect(pkg.repository?.url).toBe("git+https://github.com/cephalopod-ai/cuttlefish.git");
    expect(pkg.bugs?.url).toBe("https://github.com/cephalopod-ai/cuttlefish/issues");
  });
});
