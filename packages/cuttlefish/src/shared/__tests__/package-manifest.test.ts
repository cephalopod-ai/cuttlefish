import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("package manifest", () => {
  it("publishes the hook relay asset used by connector-backed sessions", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")) as {
      files?: string[];
    };

    expect(pkg.files).toContain("assets/");
  });
});
