import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock the paths module so org/, org/_changes/, and the audit log all live under
// a throwaway temp home. Getters read top-level lets assigned in beforeEach (the
// same lazy-getter trick org.test.ts uses to keep vi.mock's factory hoist-safe).
let orgDir: string;
let changesDir: string;
let draftsDir: string;
let retiredDir: string;
let auditLog: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return orgDir;
  },
  get ORG_CHANGES_DIR() {
    return changesDir;
  },
  get ORG_DRAFTS_DIR() {
    return draftsDir;
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

import { scanOrg } from "../org.js";
import {
  buildBeforeAfterYaml,
  createChangeRequest,
  getChangeRequest,
  listChangeRequests,
  updateChangeRequestStatus,
} from "../org-changes.js";

function writeEmployee(subdir: string, filename: string, content: string) {
  const dir = path.join(orgDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "org-changes-test-"));
  orgDir = path.join(home, "org");
  changesDir = path.join(orgDir, "_changes");
  draftsDir = path.join(orgDir, "_drafts");
  retiredDir = path.join(orgDir, "_retired");
  auditLog = path.join(home, "audit.jsonl");
  fs.mkdirSync(orgDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(path.dirname(orgDir), { recursive: true, force: true });
});

describe("scanOrg — reserved HR dirs", () => {
  it("ignores _changes / _drafts / _retired when loading employees", () => {
    writeEmployee("engineering", "dev.yaml", "name: dev\npersona: A developer\n");
    // Decoys that must NOT be loaded as employees:
    writeEmployee("_changes", "change-1.yaml", "name: ghost\npersona: not an employee\n");
    writeEmployee("_drafts", "draft.yaml", "name: draft-ghost\npersona: draft\n");
    writeEmployee("_retired", "old.yaml", "name: retired-ghost\npersona: retired\n");

    const registry = scanOrg();
    expect(registry.has("dev")).toBe(true);
    expect(registry.has("ghost")).toBe(false);
    expect(registry.has("draft-ghost")).toBe(false);
    expect(registry.has("retired-ghost")).toBe(false);
    expect(registry.size).toBe(1);
  });
});

describe("org-changes store", () => {
  it("creates, reads back, and lists a change request", () => {
    const created = createChangeRequest({
      changeType: "create_agent",
      employeeName: "ui-test-reviewer",
      proposed: {
        displayName: "UI Test Reviewer",
        department: "engineering",
        rank: "employee",
        engine: "claude",
        model: "sonnet",
        persona: "You review flaky UI tests.",
      },
      rationale: "Need flaky-test triage.",
      proposedBy: "user",
      originSessionId: "operator-chat-1",
      status: "draft",
    });

    expect(created.id).toMatch(/^change-/);
    expect(created.status).toBe("draft");
    expect(created.beforeYaml).toBeNull();
    expect(created.afterYaml).toContain("ui-test-reviewer");

    const fetched = getChangeRequest(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.employeeName).toBe("ui-test-reviewer");
    expect(fetched!.originSessionId).toBe("operator-chat-1");

    const all = listChangeRequests();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(created.id);
  });

  it("filters list by status", () => {
    createChangeRequest({ changeType: "create_agent", employeeName: "a", proposed: {}, status: "draft" });
    createChangeRequest({ changeType: "create_agent", employeeName: "b", proposed: {}, status: "pending_approval" });

    expect(listChangeRequests({ status: "draft" })).toHaveLength(1);
    expect(listChangeRequests({ status: "pending_approval" })).toHaveLength(1);
    expect(listChangeRequests({ status: ["draft", "pending_approval"] })).toHaveLength(2);
  });

  it("transitions status and bumps updatedAt", async () => {
    const created = createChangeRequest({ changeType: "create_agent", employeeName: "c", proposed: {}, status: "draft" });
    await new Promise((r) => setTimeout(r, 2));
    const updated = updateChangeRequestStatus(created.id, "pending_approval", { hrCritique: "Looks redundant." });
    expect(updated!.status).toBe("pending_approval");
    expect(updated!.hrCritique).toBe("Looks redundant.");
    expect(updated!.updatedAt >= created.updatedAt).toBe(true);
    expect(getChangeRequest(created.id)!.status).toBe("pending_approval");
  });

  it("change-request files do not leak into scanOrg", () => {
    createChangeRequest({
      changeType: "create_agent",
      employeeName: "shadow",
      proposed: { persona: "x" },
      status: "draft",
    });
    // The JSON change file lives under org/_changes/ — scanOrg must not see it.
    expect(scanOrg().has("shadow")).toBe(false);
  });
});

describe("buildBeforeAfterYaml", () => {
  it("renders an update diff by merging onto current YAML", () => {
    writeEmployee(
      "engineering",
      "dev.yaml",
      "name: dev\ndisplayName: Dev\ndepartment: engineering\nrank: employee\nengine: claude\nmodel: sonnet\npersona: Old persona\n",
    );
    const { beforeYaml, afterYaml } = buildBeforeAfterYaml("modify_instructions", "dev", {
      persona: "New persona",
    });
    expect(beforeYaml).toContain("Old persona");
    expect(afterYaml).toContain("New persona");
    expect(afterYaml).not.toContain("Old persona");
    // Untouched fields are preserved.
    expect(afterYaml).toContain("engine: claude");
  });
});
