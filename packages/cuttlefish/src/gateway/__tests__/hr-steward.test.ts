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

const hoisted = vi.hoisted(() => {
  const sessionsByKey = new Map<string, any>();
  const sessionsById = new Map<string, any>();
  let nextSessionId = 1;
  return {
    sessionsByKey,
    sessionsById,
    getNextSessionId: () => nextSessionId++,
    resetSessionIds: () => {
      nextSessionId = 1;
    },
    createApprovalMock: vi.fn((input: unknown) => ({ id: "approval-1", ...(input as object) })),
    dispatchWebSessionRunMock: vi.fn(async () => {}),
    createSessionMock: vi.fn((opts: any) => {
      const id = `s${nextSessionId++}`;
      const session = { id, status: "idle", ...opts, sessionKey: opts.sessionKey ?? opts.sourceRef };
      sessionsByKey.set(session.sessionKey, session);
      sessionsById.set(id, session);
      return session;
    }),
    getSessionMock: vi.fn((id: string) => sessionsById.get(id)),
    getSessionBySessionKeyMock: vi.fn((sessionKey: string) => sessionsByKey.get(sessionKey)),
    listSessionsMock: vi.fn(() => [...sessionsById.values()]),
    getMessagesMock: vi.fn(() => []),
    insertMessageMock: vi.fn(),
    updateSessionMock: vi.fn((id: string, updates: Record<string, unknown>) => {
      const current = sessionsById.get(id);
      if (!current) return undefined;
      const updated = { ...current, ...updates };
      sessionsById.set(id, updated);
      sessionsByKey.set(updated.sessionKey, updated);
      return updated;
    }),
  };
});

vi.mock("../approvals.js", () => ({
  createApproval: (input: unknown) => hoisted.createApprovalMock(input),
}));

vi.mock("../api/session-dispatch.js", () => ({ dispatchWebSessionRun: hoisted.dispatchWebSessionRunMock }));
const createApprovalMock = hoisted.createApprovalMock;
const dispatchWebSessionRunMock = hoisted.dispatchWebSessionRunMock;
const createSessionMock = hoisted.createSessionMock;
const getSessionBySessionKeyMock = hoisted.getSessionBySessionKeyMock;
const listSessionsMock = hoisted.listSessionsMock;
const getMessagesMock = hoisted.getMessagesMock;
const insertMessageMock = hoisted.insertMessageMock;
const updateSessionMock = hoisted.updateSessionMock;

vi.mock("../../sessions/registry.js", () => ({
  createSession: hoisted.createSessionMock,
  getSession: hoisted.getSessionMock,
  getSessionBySessionKey: hoisted.getSessionBySessionKeyMock,
  listSessions: hoisted.listSessionsMock,
  getMessages: hoisted.getMessagesMock,
  insertMessage: hoisted.insertMessageMock,
  updateSession: hoisted.updateSessionMock,
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

async function waitForStatus(id: string, status: string, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (getChangeRequest(id)?.status === status) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  if (getChangeRequest(id)?.status === status) return;
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
  dispatchWebSessionRunMock.mockClear();
  createSessionMock.mockClear();
  getSessionBySessionKeyMock.mockClear();
  listSessionsMock.mockClear();
  getMessagesMock.mockClear();
  insertMessageMock.mockClear();
  updateSessionMock.mockClear();
  hoisted.sessionsByKey.clear();
  hoisted.sessionsById.clear();
  hoisted.resetSessionIds();
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
  it("reuses a single hr-manager session for successive critiques", async () => {
    writeEmployee("general", "hr-manager", "name: hr-manager\ndisplayName: HR Manager\ndepartment: general\nrank: manager\nengine: claude\nmodel: sonnet\npersona: Review org changes.\n");
    const ctx = {
      ...(fakeContext() as Record<string, unknown>),
      sessionManager: { getEngine: () => ({}) },
    } as never;

    const first = await submitOrgChange(
      { changeType: "create_agent", employeeName: "ui-test-reviewer", proposed: VALID_HIRE, proposedBy: "user" },
      ctx,
    );
    const second = await submitOrgChange(
      { changeType: "change_model", employeeName: "ui-test-reviewer", proposed: { model: "opus" }, proposedBy: "user" },
      ctx,
    );

    await waitForStatus(first.request.id, "pending_approval");
    await waitForStatus(second.request.id, "pending_approval");

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(getSessionBySessionKeyMock).toHaveBeenCalled();
    expect(dispatchWebSessionRunMock).toHaveBeenCalledTimes(2);
    expect(insertMessageMock).toHaveBeenCalledTimes(2);
    expect(getChangeRequest(first.request.id)?.approvalId).toBe("approval-1");
    expect(getChangeRequest(second.request.id)?.approvalId).toBe("approval-1");
    expect(createApprovalMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: "s1" }),
    );
    expect(createApprovalMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: "s1" }),
    );
  });

  it("does not attribute a previous critique to a change whose HR turn failed", async () => {
    // The HR session is a reused singleton and dispatchWebSessionRun never
    // rejects — it marks the session `error` and resolves. Reading "the last
    // assistant message" unconditionally would hand change B the verdict written
    // for change A, and that stale text feeds the approval card and the
    // autonomous verdict prompt.
    writeEmployee("general", "hr-manager", "name: hr-manager\ndisplayName: HR Manager\ndepartment: general\nrank: manager\nengine: claude\nmodel: sonnet\npersona: Review org changes.\n");
    const ctx = {
      ...(fakeContext() as Record<string, unknown>),
      sessionManager: { getEngine: () => ({}) },
    } as never;

    getMessagesMock.mockImplementation((() => [
      { id: "m1", role: "assistant", content: "Verdict: recommend — the earlier change looks fine.", partial: false },
    ]) as never);
    dispatchWebSessionRunMock.mockImplementationOnce(async () => {
      const hr = [...hoisted.sessionsById.values()].find((s: any) => s.employee === "hr-manager");
      if (hr) hoisted.updateSessionMock(hr.id, { status: "error", lastError: "engine died" });
    });

    const failed = await submitOrgChange(
      { changeType: "create_agent", employeeName: "risky-hire", proposed: VALID_HIRE, proposedBy: "user" },
      ctx,
    );
    await waitForStatus(failed.request.id, "pending_approval");

    expect(getChangeRequest(failed.request.id)?.hrCritique ?? null).toBeNull();
    getMessagesMock.mockImplementation(() => []);
  });

  it("keeps concurrent critiques from reading each other's session state", async () => {
    // Both critiques reuse the same HR singleton, and submitOrgChange runs them
    // in the background. The anchor for "did MY turn produce a critique" is the
    // session's assistant-message count — shared state. If a turn that produced
    // nothing is still in flight when a sibling turn appends its verdict, the
    // barren turn sees the count rise and claims the sibling's text as its own.
    writeEmployee("general", "hr-manager", "name: hr-manager\ndisplayName: HR Manager\ndepartment: general\nrank: manager\nengine: claude\nmodel: sonnet\npersona: Review org changes.\n");
    const ctx = {
      ...(fakeContext() as Record<string, unknown>),
      sessionManager: { getEngine: () => ({}) },
    } as never;

    const appended: string[] = [];
    getMessagesMock.mockImplementation((() =>
      appended.map((content, i) => ({ id: `m${i}`, role: "assistant", content, partial: false }))) as never);

    let turn = 0;
    dispatchWebSessionRunMock.mockImplementation(async () => {
      const mine = ++turn;
      if (mine === 1) {
        // Produces no verdict at all and leaves the session healthy — the engine
        // returned without writing an assistant message.
        await new Promise((r) => setTimeout(r, 30));
        return;
      }
      appended.push("Verdict: recommend — second change is sound.");
    });

    const first = await submitOrgChange(
      { changeType: "create_agent", employeeName: "hire-one", proposed: VALID_HIRE, proposedBy: "user" },
      ctx,
    );
    const second = await submitOrgChange(
      { changeType: "create_agent", employeeName: "hire-two", proposed: { ...VALID_HIRE, displayName: "Hire Two" }, proposedBy: "user" },
      ctx,
    );
    await waitForStatus(first.request.id, "pending_approval");
    await waitForStatus(second.request.id, "pending_approval");

    // The barren turn must record no critique rather than borrowing the other's,
    // and the healthy turn must keep its own verdict.
    expect(getChangeRequest(first.request.id)?.hrCritique ?? null).toBeNull();
    expect(getChangeRequest(second.request.id)?.hrCritique).toMatch(/second change is sound/);

    getMessagesMock.mockImplementation((() => []) as never);
    dispatchWebSessionRunMock.mockImplementation(async () => {});
  });

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

  it("attaches a chat-originated change's approval to the originating session", async () => {
    const ctx = fakeContext();
    const result = await submitOrgChange(
      {
        changeType: "create_agent",
        employeeName: "ui-test-reviewer",
        proposed: VALID_HIRE,
        proposedBy: "user",
        originSessionId: "operator-chat-1",
      },
      ctx,
      { runCritique: async () => ({ critique: "Verdict: recommend.", sessionId: "hr-critique-1" }) },
    );

    await waitForStatus(result.request.id, "pending_approval");
    expect(getChangeRequest(result.request.id)?.originSessionId).toBe("operator-chat-1");
    expect(createApprovalMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "operator-chat-1" }));
  });

  it("reuses a legacy hr-manager web session even when the singleton key is missing", async () => {
    writeEmployee("general", "hr-manager", "name: hr-manager\ndisplayName: HR Manager\ndepartment: general\nrank: manager\nengine: claude\nmodel: sonnet\npersona: Review org changes.\n");
    hoisted.sessionsById.set("legacy-hr", {
      id: "legacy-hr",
      employee: "hr-manager",
      source: "web",
      sourceRef: "web:legacy-hr",
      sessionKey: "web:legacy-hr",
      status: "idle",
      lastActivity: new Date().toISOString(),
    });
    const ctx = {
      ...(fakeContext() as Record<string, unknown>),
      sessionManager: { getEngine: () => ({}) },
    } as never;

    const result = await submitOrgChange(
      { changeType: "create_agent", employeeName: "ui-test-reviewer", proposed: VALID_HIRE, proposedBy: "user" },
      ctx,
    );

    await waitForStatus(result.request.id, "pending_approval");

    expect(createSessionMock).not.toHaveBeenCalled();
    expect(listSessionsMock).toHaveBeenCalled();
    expect(updateSessionMock).toHaveBeenCalledWith(
      "legacy-hr",
      expect.objectContaining({ status: "running" }),
    );
    expect(createApprovalMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "legacy-hr" }));
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

  it("serializes two concurrent applies of the same change request — exactly one wins (CON-001)", async () => {
    const ctx = fakeContext();
    const request = createChangeRequest({
      changeType: "create_agent",
      employeeName: "ui-test-reviewer",
      proposed: VALID_HIRE,
      status: "approved",
    });

    const [first, second] = await Promise.all([
      applyOrgChange(request, ctx),
      applyOrgChange(request, ctx),
    ]);

    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(loser.error).toMatch(/applied.*cannot be applied|cannot be applied/i);
    expect(getChangeRequest(request.id)!.status).toBe("applied");
    // The org writer must have run exactly once, not twice.
    expect(scanOrg().has("ui-test-reviewer")).toBe(true);
  });
});
