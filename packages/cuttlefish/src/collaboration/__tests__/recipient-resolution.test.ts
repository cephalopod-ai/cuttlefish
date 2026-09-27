import { describe, expect, it } from "vitest";
import type { Employee, Session } from "../../shared/types.js";
import { resolveOrgHierarchy } from "../../gateway/org-hierarchy.js";
import {
  latestDirectManagementSession,
  latestWritableSessionForEmployee,
  managementRoster,
  resolveManagementRecipients,
  resolveTeamRecipients,
} from "../recipient-resolution.js";

const employee = (name: string, rank: Employee["rank"], reportsTo?: string): Employee => ({
  name,
  displayName: name,
  department: "engineering",
  rank,
  engine: "codex",
  model: "gpt-5.6-sol",
  persona: name,
  reportsTo,
});

const projectSession = (id: string, employeeId: string): Session => ({
  id,
  engine: "codex",
  engineSessionId: null,
  source: "web",
  sourceRef: id,
  connector: "web",
  sessionKey: id,
  replyContext: null,
  messageId: null,
  transportMeta: null,
  employee: employeeId,
  model: "gpt-5.6-sol",
  title: id,
  promptExcerpt: id,
  parentSessionId: null,
  userId: null,
  effortLevel: null,
  cwd: null,
  status: "idle",
  totalCost: 0,
  totalTurns: 0,
  lastContextTokens: null,
  createdAt: "2026-01-01T00:00:00Z",
  lastActivity: "2026-01-01T00:00:00Z",
  lastError: null,
});

describe("operator messages never continue an inbound A2A task session", () => {
  // A2A task sessions are management-lane sessions with source "web"; their
  // replies are projected to the external partner as the task's artifact.
  const operator = { ...projectSession("operator-thread", "lead"), lastActivity: "2026-01-01T00:00:00Z" };
  const a2aByKey = { ...projectSession("a2a-new", "lead"), sessionKey: "a2a:task:t-1", lastActivity: "2026-01-03T00:00:00Z" };
  const a2aByMeta = {
    ...projectSession("a2a-linked", "lead"),
    transportMeta: { a2a: { taskId: "t-2", contextId: "c-2", clientId: "partner", service: "svc", skillId: "svc" } },
    lastActivity: "2026-01-02T00:00:00Z",
  };

  it("management lane skips A2A sessions even when they are the most recent", () => {
    expect(latestDirectManagementSession([a2aByKey, a2aByMeta, operator], "lead")?.id).toBe("operator-thread");
    expect(latestDirectManagementSession([a2aByKey, a2aByMeta], "lead")).toBeUndefined();
  });

  it("team lane skips A2A sessions even when they are the most recent", () => {
    expect(latestWritableSessionForEmployee([a2aByKey, a2aByMeta, operator], "lead")?.id).toBe("operator-thread");
    expect(latestWritableSessionForEmployee([a2aByKey], "lead")).toBeUndefined();
  });
});

describe("collaboration recipient resolution", () => {
  const employees = new Map([
    ["coo", employee("coo", "executive")],
    ["lead", employee("lead", "manager", "coo")],
    ["program-manager", employee("program-manager", "manager", "coo")],
    ["dev-a", employee("dev-a", "employee", "lead")],
    ["dev-b", employee("dev-b", "senior", "lead")],
  ]);

  it("expands Team all to distinct active non-manager participants", () => {
    const result = resolveTeamRecipients({
      recipientMode: "all",
      confirmAllRecipients: ["dev-a", "dev-b"],
      projectSessions: [projectSession("a1", "dev-a"), projectSession("a2", "dev-a"), projectSession("b", "dev-b"), projectSession("m", "lead")],
      employees,
    });
    expect(result).toEqual({ recipientIds: ["dev-a", "dev-b"] });
  });

  it("rejects a stale Team all confirmation snapshot", () => {
    const result = resolveTeamRecipients({
      recipientMode: "all",
      confirmAllRecipients: ["dev-a"],
      projectSessions: [projectSession("a", "dev-a"), projectSession("b", "dev-b")],
      employees,
    });
    expect(result.error).toContain("requires confirmation");
  });

  it("rejects managers and non-participants in Team", () => {
    expect(resolveTeamRecipients({
      requestedIds: ["lead", "missing"],
      projectSessions: [projectSession("a", "dev-a"), projectSession("m", "lead")],
      employees,
    }).error).toContain("not active non-manager participants");
  });

  it("resolves a single common project lead before Program Manager and COO", () => {
    const roster = managementRoster(employees);
    const result = resolveManagementRecipients({
      projectParticipantIds: ["dev-a", "dev-b"],
      roster,
      hierarchy: resolveOrgHierarchy(employees),
    });
    expect(result).toMatchObject({ recipientIds: ["lead"], defaultReason: "project_lead" });
  });

  it("falls back to Program Manager and requires an exact current roster for all", () => {
    const roster = managementRoster(employees);
    const fallback = resolveManagementRecipients({ roster, hierarchy: resolveOrgHierarchy(employees) });
    expect(fallback).toMatchObject({ recipientIds: ["program-manager"], defaultReason: "program_manager" });
    const rejected = resolveManagementRecipients({ recipientMode: "all", confirmAllRecipients: ["lead"], roster, hierarchy: resolveOrgHierarchy(employees) });
    expect(rejected.error).toContain("requires confirmation");
    const accepted = resolveManagementRecipients({
      recipientMode: "all",
      confirmAllRecipients: roster.filter((entry) => entry.active).map((entry) => entry.id),
      roster,
      hierarchy: resolveOrgHierarchy(employees),
    });
    expect(accepted.recipientIds).toHaveLength(roster.filter((entry) => entry.active).length);
  });
});
