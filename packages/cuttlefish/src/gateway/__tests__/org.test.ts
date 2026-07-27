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
  // safeWriteYaml(audit) appends to AUDIT_LOG; keep it inside the temp dir so
  // the DFI-004 create/update-invariant tests below don't write outside it.
  get AUDIT_LOG() {
    return path.join(tmpDir, "audit.jsonl");
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

import {
  createEmployeeYaml,
  findEmployeeYamlPath,
  resetOrgScanCacheForTests,
  scanOrg,
  updateEmployeeYaml,
  validateEmployeeCreate as validateEmployeeCreateFromFacade,
  validateEmployeeUpdate as validateEmployeeUpdateFromFacade,
} from "../org.js";
import {
  validateEmployeeCreate,
  validateEmployeeUpdate,
} from "../org-validation.js";
import type { OrgWarning } from "../../shared/types.js";

function writeYaml(subdir: string, filename: string, content: string) {
  const dir = path.join(tmpDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

describe("org facade validation compatibility", () => {
  it("re-exports the validation implementations without changing the public import path", () => {
    expect(validateEmployeeCreateFromFacade).toBe(validateEmployeeCreate);
    expect(validateEmployeeUpdateFromFacade).toBe(validateEmployeeUpdate);
  });
});

describe("scanOrg — alwaysNotify field", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-test-"));
    resetOrgScanCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetOrgScanCacheForTests();
  });

  it("defaults alwaysNotify to true when not specified in YAML", () => {
    writeYaml("platform", "dev.yaml", `
name: dev
persona: A developer
`);
    const registry = scanOrg();
    const emp = registry.get("dev");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("parses alwaysNotify: false from YAML", () => {
    writeYaml("platform", "worker.yaml", `
name: worker
persona: A worker
alwaysNotify: false
`);
    const registry = scanOrg();
    const emp = registry.get("worker");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(false);
  });

  it("parses alwaysNotify: true from YAML", () => {
    writeYaml("platform", "lead.yaml", `
name: lead
persona: A lead
alwaysNotify: true
`);
    const registry = scanOrg();
    const emp = registry.get("lead");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("ignores non-boolean alwaysNotify values and defaults to true", () => {
    writeYaml("platform", "bad.yaml", `
name: bad
persona: A bad config
alwaysNotify: "yes"
`);
    const registry = scanOrg();
    const emp = registry.get("bad");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("reuses the parsed registry when org files are unchanged", () => {
    writeYaml("platform", "cached.yaml", `
name: cached
persona: Cached employee
`);
    const readSpy = vi.spyOn(fs, "readFileSync");

    expect(scanOrg().get("cached")?.name).toBe("cached");
    const readsAfterFirstScan = readSpy.mock.calls.length;

    expect(scanOrg().get("cached")?.name).toBe("cached");
    expect(readSpy.mock.calls.length).toBe(readsAfterFirstScan);
  });
});

describe("scanOrg — duplicate employee names (DFI-001)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-test-dup-"));
    resetOrgScanCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetOrgScanCacheForTests();
  });

  it("keeps the deterministically-first file, warns on the collision, and read/write agree on which file that is", () => {
    // "eng" sorts before "sales", so eng/dup.yaml is the deterministic winner
    // regardless of filesystem readdir order.
    writeYaml("sales", "dup.yaml", "name: dup\ndisplayName: Sales Dup\npersona: from sales\n");
    writeYaml("eng", "dup.yaml", "name: dup\ndisplayName: Eng Dup\npersona: from eng\n");

    const warnings: OrgWarning[] = [];
    const registry = scanOrg(warnings);

    expect(registry.get("dup")?.displayName).toBe("Eng Dup");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe("duplicate_name");
    expect(warnings[0].employee).toBe("dup");

    // findEmployeeYamlPath (backing update/delete/retire) must resolve to the
    // SAME physical file scanOrg kept, or a write silently targets the file
    // that isn't in the active registry.
    expect(findEmployeeYamlPath("dup")).toBe(path.join(tmpDir, "eng", "dup.yaml"));
  });

  it("does not warn when every employee name is unique", () => {
    writeYaml("eng", "a.yaml", "name: a\npersona: x\n");
    writeYaml("eng", "b.yaml", "name: b\npersona: x\n");
    const warnings: OrgWarning[] = [];
    scanOrg(warnings);
    expect(warnings).toHaveLength(0);
  });
});

describe("createEmployeeYaml / updateEmployeeYaml — persisted-field invariants (DFI-004)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-test-invariants-"));
    resetOrgScanCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetOrgScanCacheForTests();
  });

  it("refuses to create an employee YAML with an invalid rank even bypassing the API-layer validator", () => {
    // createEmployeeYaml catches the validate() throw internally (same as any
    // other write failure) and reports it as a normal false return + warn log,
    // rather than propagating — so no file is left on disk either way.
    const ok = createEmployeeYaml({
      name: "bad-rank",
      displayName: "Bad Rank",
      department: "eng",
      rank: "not-a-real-rank" as never,
      engine: "claude",
      model: "sonnet",
      persona: "x",
    });
    expect(ok).toBe(false);
    expect(findEmployeeYamlPath("bad-rank")).toBeUndefined();
  });

  it("refuses to write an update that sets an invalid lifecycle, leaving the prior file untouched", () => {
    writeYaml("eng", "ok.yaml", "name: ok\ndisplayName: Ok\npersona: x\nlifecycle: active\n");
    resetOrgScanCacheForTests();
    const ok = updateEmployeeYaml("ok", { lifecycle: "not-a-real-lifecycle" as never });
    expect(ok).toBe(false);
    resetOrgScanCacheForTests();
    expect(scanOrg().get("ok")?.lifecycle).toBe("active");
  });

  it("still allows a structurally valid update", () => {
    writeYaml("eng", "ok2.yaml", "name: ok2\ndisplayName: Ok2\npersona: x\n");
    resetOrgScanCacheForTests();
    expect(updateEmployeeYaml("ok2", { rank: "senior" })).toBe(true);
    resetOrgScanCacheForTests();
    expect(scanOrg().get("ok2")?.rank).toBe("senior");
  });
});
