import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We need to mock ORG_DIR to point to a temp directory
let tmpDir: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return tmpDir;
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { scanOrg, validateEmployeeCreate } from "../org.js";
import type { OrgWarning, CuttlefishConfig } from "../../shared/types.js";

function writeYaml(subdir: string, filename: string, content: string) {
  const dir = path.join(tmpDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

const baseConfig = { engines: { default: "claude" } } as unknown as CuttlefishConfig;

describe("validateEmployeeCreate — case-insensitive duplicate names (I-3)", () => {
  it("rejects a name that differs only in casing from an existing employee", () => {
    const result = validateEmployeeCreate(
      baseConfig,
      { name: "Emoji-Tester", displayName: "Emoji Tester", persona: "A tester", department: "general" },
      ["emoji-tester"],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("already exists");
  });

  it("still allows a genuinely new name", () => {
    const result = validateEmployeeCreate(
      baseConfig,
      {
        name: "brand-new",
        displayName: "Brand New",
        persona: "A tester",
        department: "general",
        engine: "claude",
        model: "opus",
      },
      ["emoji-tester"],
    );
    expect(result.ok).toBe(true);
  });
});

describe("scanOrg — parse-error warnings (I-5)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-defect-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("omits a broken employee file from the registry but records a parse_error warning when asked", () => {
    writeYaml("general", "assistant.yaml", "name: assistant\n  bad indent: [unterminated\nengine: claude\n");
    writeYaml("general", "ok.yaml", "name: ok\npersona: A fine employee\n");

    const warnings: OrgWarning[] = [];
    const registry = scanOrg(warnings);

    expect(registry.has("assistant")).toBe(false);
    expect(registry.has("ok")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual(
      expect.objectContaining({ type: "parse_error", message: expect.stringContaining("assistant.yaml") }),
    );
  });

  it("does not push any warnings when no warningsOut array is passed (back-compat for existing call sites)", () => {
    writeYaml("general", "assistant.yaml", "name: assistant\n  bad indent: [unterminated\nengine: claude\n");
    expect(() => scanOrg()).not.toThrow();
  });
});
