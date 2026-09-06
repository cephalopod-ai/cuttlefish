import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return tmpDir;
  },
  get AUDIT_LOG() {
    return path.join(tmpDir, "audit.jsonl");
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { resetOrgScanCacheForTests, scanOrg } from "../org.js";
import { validateEmployeeCreate } from "../org-validation.js";
import { isReservedActorName, reservedActorNames } from "../reserved-actors.js";
import type { OrgWarning, CuttlefishConfig } from "../../shared/types.js";

const baseConfig = { engines: { default: "claude" } } as unknown as CuttlefishConfig;

function writeYaml(subdir: string, filename: string, content: string) {
  const dir = path.join(tmpDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

describe("isReservedActorName (UPS-A5)", () => {
  it("claims every name the audit layer already uses", () => {
    for (const name of reservedActorNames()) {
      expect(isReservedActorName(name)).toBe(true);
    }
  });

  it("is case- and whitespace-insensitive, because the comparisons it protects are", () => {
    expect(isReservedActorName("Operator")).toBe(true);
    expect(isReservedActorName("  SYSTEM ")).toBe(true);
    expect(isReservedActorName("User")).toBe(true);
  });

  it("claims the machine-minted author prefixes", () => {
    expect(isReservedActorName("cron:nightly-sweep")).toBe(true);
    expect(isReservedActorName("session:abc123")).toBe(true);
    expect(isReservedActorName("workflow:release")).toBe(true);
  });

  it("leaves ordinary employee names alone", () => {
    for (const name of ["dev", "alice", "hr-manager", "operations-lead", "systemsanalyst", "userland"]) {
      expect(isReservedActorName(name)).toBe(false);
    }
    expect(isReservedActorName("")).toBe(false);
  });
});

describe("employee creation refuses a reserved name (UPS-A5)", () => {
  it("refuses each reserved name with an explanation", () => {
    for (const name of ["operator", "user", "system", "session", "cron"]) {
      const result = validateEmployeeCreate(
        baseConfig,
        { name, displayName: "X", department: "platform", persona: "p", engine: "claude", model: "opus" },
        [],
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("reserved");
    }
  });

  it("still accepts an ordinary name", () => {
    const result = validateEmployeeCreate(
      baseConfig,
      { name: "operations-lead", displayName: "Ops Lead", department: "platform", persona: "p", engine: "claude", model: "opus" },
      [],
    );
    expect(result.ok).toBe(true);
  });
});

describe("scanOrg refuses to load a reserved-name YAML (UPS-A5)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-reserved-"));
    resetOrgScanCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetOrgScanCacheForTests();
  });

  it("skips a hand-written employee that claims the operator identity, and says why", () => {
    writeYaml("platform", "operator.yaml", `
name: operator
persona: Pretending to be the human
`);
    const warnings: OrgWarning[] = [];
    const registry = scanOrg(warnings);

    expect(registry.has("operator")).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe("reserved_name");
    expect(warnings[0].employee).toBe("operator");
    expect(warnings[0].message).toContain("reserved");
  });

  it("skips a case-variant of a reserved name too", () => {
    writeYaml("platform", "System.yaml", `
name: System
persona: Also not an employee
`);
    const registry = scanOrg();
    expect(registry.size).toBe(0);
  });

  it("loads the rest of the org when one file is skipped", () => {
    writeYaml("platform", "operator.yaml", "name: operator\npersona: nope\n");
    writeYaml("platform", "dev.yaml", "name: dev\npersona: a developer\n");

    const registry = scanOrg();
    expect(registry.has("operator")).toBe(false);
    expect(registry.get("dev")).toBeDefined();
  });
});
