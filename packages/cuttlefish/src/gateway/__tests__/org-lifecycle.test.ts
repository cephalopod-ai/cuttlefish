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
  validateOrgChange,
} from "../org.js";
import type { CuttlefishConfig } from "../../shared/types.js";

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

  it("refuses to retire a manager who still has direct reports (DFI-003)", () => {
    writeEmployee("eng", "mgr.yaml", "name: mgr\ndisplayName: Manager\npersona: leads a team\nrank: manager\n");
    writeEmployee("eng", "report.yaml", "name: report\ndisplayName: Report\npersona: reports to mgr\nreportsTo: mgr\n");

    const ok = retireEmployeeYaml("mgr");
    expect(ok).toBe(false);

    // Refused, not partially applied: still active, still in the original file.
    expect(scanOrg().has("mgr")).toBe(true);
    expect(findEmployeeYamlPath("mgr")).toBe(path.join(orgDir, "eng", "mgr.yaml"));
    expect(listRetiredEmployees()).toHaveLength(0);
  });

  it("allows retiring once the last report is reassigned", () => {
    writeEmployee("eng", "mgr2.yaml", "name: mgr2\ndisplayName: Manager 2\npersona: leads a team\nrank: manager\n");
    writeEmployee("eng", "report2.yaml", "name: report2\ndisplayName: Report 2\npersona: x\nreportsTo: other\n");

    expect(retireEmployeeYaml("mgr2")).toBe(true);
    expect(scanOrg().has("mgr2")).toBe(false);
  });
});

describe("validateOrgChange — retire_agent orphan guard (DFI-003)", () => {
  const config = { engines: { default: "claude" } } as unknown as CuttlefishConfig;

  it("rejects a retire_agent change while dependents remain", () => {
    writeEmployee("eng", "mgr.yaml", "name: mgr\ndisplayName: Manager\npersona: x\nrank: manager\n");
    writeEmployee("eng", "report.yaml", "name: report\ndisplayName: Report\npersona: x\nreportsTo: mgr\n");

    const result = validateOrgChange(config, { changeType: "retire_agent", employeeName: "mgr", proposed: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("report");
  });

  it("allows a retire_agent change once there are no dependents", () => {
    writeEmployee("eng", "solo.yaml", "name: solo\ndisplayName: Solo\npersona: x\n");
    const result = validateOrgChange(config, { changeType: "retire_agent", employeeName: "solo", proposed: {} });
    expect(result.ok).toBe(true);
  });

  it("still allows disable_agent with dependents present (no orphan risk — stays in the registry)", () => {
    writeEmployee("eng", "mgr3.yaml", "name: mgr3\ndisplayName: Manager 3\npersona: x\nrank: manager\n");
    writeEmployee("eng", "report3.yaml", "name: report3\ndisplayName: Report 3\npersona: x\nreportsTo: mgr3\n");
    const result = validateOrgChange(config, { changeType: "disable_agent", employeeName: "mgr3", proposed: {} });
    expect(result.ok).toBe(true);
  });
});
