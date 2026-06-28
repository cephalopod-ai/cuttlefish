import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let orgDir: string;
let retiredDir: string;
let auditLog: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return orgDir;
  },
  get ORG_RETIRED_DIR() {
    return retiredDir;
  },
  get AUDIT_LOG() {
    return auditLog;
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  scanOrg,
  isActiveEmployee,
  retireEmployeeYaml,
  listRetiredEmployees,
  findEmployeeYamlPath,
} from "../org.js";

function writeEmployee(subdir: string, filename: string, content: string) {
  const dir = path.join(orgDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "org-lifecycle-test-"));
  orgDir = path.join(home, "org");
  retiredDir = path.join(orgDir, "_retired");
  auditLog = path.join(home, "audit.jsonl");
  fs.mkdirSync(orgDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(path.dirname(orgDir), { recursive: true, force: true });
});

describe("scanOrg — lifecycle", () => {
  it("defaults lifecycle to active when absent", () => {
    writeEmployee("eng", "dev.yaml", "name: dev\npersona: A dev\n");
    expect(scanOrg().get("dev")!.lifecycle).toBe("active");
  });

  it("parses an explicit lifecycle and ignores an invalid one", () => {
    writeEmployee("eng", "a.yaml", "name: a\npersona: x\nlifecycle: disabled\n");
    writeEmployee("eng", "b.yaml", "name: b\npersona: x\nlifecycle: bogus\n");
    const reg = scanOrg();
    expect(reg.get("a")!.lifecycle).toBe("disabled");
    expect(reg.get("b")!.lifecycle).toBe("active");
  });
});

describe("isActiveEmployee", () => {
  it("treats active/probation as assignable and others as not", () => {
    expect(isActiveEmployee({ lifecycle: undefined })).toBe(true);
    expect(isActiveEmployee({ lifecycle: "active" })).toBe(true);
    expect(isActiveEmployee({ lifecycle: "probation" })).toBe(true);
    expect(isActiveEmployee({ lifecycle: "draft" })).toBe(false);
    expect(isActiveEmployee({ lifecycle: "disabled" })).toBe(false);
    expect(isActiveEmployee({ lifecycle: "retired" })).toBe(false);
  });
});

describe("retireEmployeeYaml", () => {
  it("moves the YAML to _retired/, stamps lifecycle, and drops it from the active scan", () => {
    writeEmployee("eng", "old.yaml", "name: old\ndisplayName: Old\npersona: legacy\n");
    expect(scanOrg().has("old")).toBe(true);

    const ok = retireEmployeeYaml("old");
    expect(ok).toBe(true);

    // Gone from the active org, original file removed.
    expect(scanOrg().has("old")).toBe(false);
    expect(findEmployeeYamlPath("old")).toBeUndefined();
    expect(fs.existsSync(path.join(orgDir, "eng", "old.yaml"))).toBe(false);

    // Present in _retired/ with lifecycle: retired.
    const retired = listRetiredEmployees();
    expect(retired).toHaveLength(1);
    expect(retired[0].name).toBe("old");
    expect(retired[0].lifecycle).toBe("retired");
    expect(fs.existsSync(path.join(retiredDir, "old.yaml"))).toBe(true);
  });

  it("returns false for an unknown employee", () => {
    expect(retireEmployeeYaml("ghost")).toBe(false);
  });
});
