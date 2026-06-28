import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { CuttlefishConfig } from "../../shared/types.js";

let home: string;
let orgDir: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return orgDir;
  },
  get ORG_CHANGES_DIR() {
    return path.join(orgDir, "_changes");
  },
  get ORG_RETIRED_DIR() {
    return path.join(orgDir, "_retired");
  },
  get ORG_POLICY_FILE() {
    return path.join(orgDir, "_policy.json");
  },
  get AUDIT_LOG() {
    return path.join(home, "audit.jsonl");
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// Approval store hits SQLite — stub it so the pipeline test stays in-memory.
const createApprovalMock = vi.fn((input: unknown) => ({ id: "approval-1", ...(input as object) }));
vi.mock("../approvals.js", () => ({
  createApproval: (input: unknown) => createApprovalMock(input),
}));

// Cut the heavy session-spawn graph; we inject runCritique in every test anyway.
vi.mock("../api/session-dispatch.js", () => ({ dispatchWebSessionRun: vi.fn(async () => {}) }));
vi.mock("../../sessions/registry.js", () => ({
  createSession: vi.fn(() => ({ id: "s1" })),
  getMessages: vi.fn(() => []),
  insertMessage: vi.fn(),
  updateSession: vi.fn(),
}));

import { submitOrgChange, applyOrgChange } from "../hr-steward.js";
import { createChangeRequest, getChangeRequest } from "../org-changes.js";
import { scanOrg } from "../org.js";
import { invalidateModelRegistry } from "../../shared/models.js";

const testConfig = {
  engines: { default: "claude" },
  gateway: {},
  portal: {},
  models: {
    claude: {
      default: "sonnet",
      models: [
        { id: "opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    },
  },
} as unknown as CuttlefishConfig;

function fakeContext() {
  return {
    getConfig: () => testConfig,
    emit: vi.fn(),
    reloadOrg: vi.fn(),
    sessionManager: { getEngine: () => undefined },
  } as never;
}

function writeEmployee(subdir: string, name: string, body: string) {
  const dir = path.join(orgDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), body, "utf-8");
}

async function waitForStatus(id: string, status: string, ms = 500): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (getChangeRequest(id)?.status === status) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`change ${id} never reached status ${status} (got ${getChangeRequest(id)?.status})`);
}

const VALID_HIRE = {
  displayName: "UI Test Reviewer",
  department: "engineering",
  rank: "employee",
  engine: "claude",
  model: "sonnet",
  persona: "You review flaky UI tests.",
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hr-steward-test-"));
  orgDir = path.join(home, "org");
  fs.mkdirSync(orgDir, { recursive: true });
  invalidateModelRegistry();
  createApprovalMock.mockClear();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("submitOrgChange — guards", () => {
  it("blocks an agent self-edit of HR and records a rejected request", async () => {
    const ctx = fakeContext();
    const result = await submitOrgChange(
      { changeType: "modify_instructions", employeeName: "hr-manager", proposed: { model: "opus" }, proposedBy: "hr-manager" },
      ctx,
      { runCritique: async () => ({ critique: "n/a" }) },
    );
    expect(result.blocked).toBe(true);
    expect(result.request.status).toBe("rejected");
    expect(result.request.hrCritique).toMatch(/Blocked/);
  });
});

describe("submitOrgChange — critique pipeline", () => {
  it("attaches the critique and opens an approval gate for a high-risk hire", async () => {
    const ctx = fakeContext();
    const result = await submitOrgChange(
      { changeType: "create_agent", employeeName: "ui-test-reviewer", proposed: VALID_HIRE, proposedBy: "user" },
      ctx,
      { runCritique: async () => ({ critique: "Verdict: recommend. No overlap.", sessionId: "crit-1" }) },
    );
    expect(result.blocked).toBe(false);
    expect(result.request.status).toBe("pending_critique");

    await waitForStatus(result.request.id, "pending_approval");
    const updated = getChangeRequest(result.request.id)!;
    expect(updated.hrCritique).toMatch(/recommend/);
    expect(updated.approvalId).toBe("approval-1");
    expect(createApprovalMock).toHaveBeenCalledTimes(1);
  });

  it("auto-applies a low-risk cosmetic edit without an approval gate", async () => {
    writeEmployee("engineering", "dev", "name: dev\ndisplayName: Dev\ndepartment: engineering\nrank: employee\nengine: claude\nmodel: sonnet\npersona: A dev\n");
    const ctx = fakeContext();
    const result = await submitOrgChange(
      { changeType: "modify_instructions", employeeName: "dev", proposed: { displayName: "Senior Dev" }, proposedBy: "user" },
      ctx,
      { runCritique: async () => ({ critique: "cosmetic" }) },
    );
    await waitForStatus(result.request.id, "applied");
    expect(createApprovalMock).not.toHaveBeenCalled();
    expect(scanOrg().get("dev")!.displayName).toBe("Senior Dev");
  });
});

describe("applyOrgChange", () => {
  it("creates a new employee and hot-reloads", async () => {
    const ctx = fakeContext();
    const request = createChangeRequest({
      changeType: "create_agent",
      employeeName: "ui-test-reviewer",
      proposed: VALID_HIRE,
      status: "approved",
    });
    const applied = await applyOrgChange(request, ctx);
    expect(applied.ok).toBe(true);
    expect(scanOrg().has("ui-test-reviewer")).toBe(true);
    expect((ctx as unknown as { reloadOrg: () => void }).reloadOrg).toBeDefined();
    expect(getChangeRequest(request.id)!.status).toBe("applied");
  });

  it("retires an employee by moving it to _retired/", async () => {
    writeEmployee("engineering", "old", "name: old\ndisplayName: Old\ndepartment: engineering\nrank: employee\nengine: claude\nmodel: sonnet\npersona: legacy\n");
    const ctx = fakeContext();
    const request = createChangeRequest({
      changeType: "retire_agent",
      employeeName: "old",
      proposed: {},
      status: "approved",
    });
    const applied = await applyOrgChange(request, ctx);
    expect(applied.ok).toBe(true);
    expect(scanOrg().has("old")).toBe(false);
    expect(fs.existsSync(path.join(orgDir, "_retired", "old.yaml"))).toBe(true);
  });

  it("rejects a change that fails validation at apply time", async () => {
    const ctx = fakeContext();
    const request = createChangeRequest({
      changeType: "change_model",
      employeeName: "ghost",
      proposed: { model: "opus" },
      status: "approved",
    });
    const applied = await applyOrgChange(request, ctx);
    expect(applied.ok).toBe(false);
    expect(getChangeRequest(request.id)!.status).toBe("rejected");
  });
});
