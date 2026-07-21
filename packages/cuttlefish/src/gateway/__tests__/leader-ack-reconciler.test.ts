import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-leader-ack-");

type Rec = typeof import("../leader-ack-reconciler.js");
type Reg = typeof import("../../sessions/registry.js");
type Ack = typeof import("../../sessions/leader-ack.js");
let rec: Rec;
let reg: Reg;
let ack: Ack;

beforeAll(async () => {
  rec = await import("../leader-ack-reconciler.js");
  reg = await import("../../sessions/registry.js");
  ack = await import("../../sessions/leader-ack.js");
  reg.initDb();
});

beforeEach(() => {
  const orgDir = path.join(tmp, "org", "general");
  fs.mkdirSync(orgDir, { recursive: true });
  fs.writeFileSync(path.join(orgDir, "hr-manager.yaml"), "name: hr-manager\ndisplayName: HR Manager\ndepartment: general\nrank: manager\nengine: claude\nmodel: opus\npersona: Handle escalations.\n");
  fs.writeFileSync(path.join(orgDir, "coo.yaml"), "name: coo\ndisplayName: COO\ndepartment: general\nrank: executive\nengine: claude\nmodel: opus\npersona: Run the org.\n");
});

describe("leader acknowledgement triage model", () => {
  const config = {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude", model: "claude-fable-5" } },
    connectors: {},
    logging: { file: true, stdout: true, level: "info" },
  } as any;

  it("routes routine COO triage to the first configured cheap-tier model at low effort", () => {
    const registry = {
      claude: {
        name: "claude",
        available: true,
        defaultModel: "claude-fable-5",
        effortMechanism: "claude-flag",
        models: [
          { id: "claude-fable-5", label: "Fable", supportsEffort: true, effortLevels: ["low", "medium"] },
          { id: "claude-haiku-4-5", label: "Haiku", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        ],
      },
    } as any;

    expect(rec.resolveLeaderAckTriageModel(config, registry)).toEqual({
      engine: "claude",
      model: "claude-haiku-4-5",
      effortLevel: "low",
    });
  });

  it("skips unavailable cheap rungs and preserves the executive fallback when none are configured", () => {
    const unavailableHaiku = {
      claude: {
        name: "claude",
        available: false,
        defaultModel: "claude-fable-5",
        effortMechanism: "claude-flag",
        models: [{ id: "claude-haiku-4-5", label: "Haiku", supportsEffort: true, effortLevels: ["low"] }],
      },
      codex: {
        name: "codex",
        available: true,
        defaultModel: "gpt-5.4-mini",
        effortMechanism: "codex-config",
        models: [{ id: "gpt-5.4-mini", label: "Mini", supportsEffort: true, effortLevels: ["low", "medium"] }],
      },
    } as any;
    expect(rec.resolveLeaderAckTriageModel(config, unavailableHaiku)).toEqual({
      engine: "codex",
      model: "gpt-5.4-mini",
      effortLevel: "low",
    });
    expect(rec.resolveLeaderAckTriageModel(config, {})).toBeNull();
  });
});

describe("leader acknowledgement reconciler", () => {
  it("contacts the direct supervisor twice before marking an executive handoff for manual human review", async () => {
    const parent = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:parent",
      prompt: "parent",
      employee: "coo",
    });
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child",
      prompt: "child",
      employee: "assistant",
      parentSessionId: parent.id,
      transportMeta: { boardTicketId: "ticket-1", boardDepartment: "general" } as any,
    });
    ack.markLeaderAckPending(child, {
      leaderSessionId: parent.id,
      leaderName: "coo",
      reportKind: "result",
      now: new Date(0).toISOString(),
    });

    const dispatchEscalation = vi.fn(async () => {});
    const dispatchParentReminder = vi.fn(async () => {});
    const deps = {
      emit: vi.fn(),
      getConfig: () => ({
        gateway: { port: 8888, host: "127.0.0.1", leaderAckTimeoutMs: 60_000 },
        engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
        connectors: {},
        logging: { file: true, stdout: true, level: "info" },
      } as any),
      now: () => 120_000,
      dispatchEscalation,
      dispatchParentReminder,
    };
    let fixed = rec.sweepLeaderAcknowledgements(deps);

    expect(fixed).toBe(0);
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "pending",
      contactAttemptCount: 2,
      lastContactAttemptAt: new Date(120_000).toISOString(),
    });
    expect(dispatchParentReminder).toHaveBeenCalledOnce();
    expect(dispatchParentReminder).toHaveBeenCalledWith(
      parent.id,
      expect.stringContaining(`/api/sessions/${child.id}?last=20`),
      expect.stringContaining("Second notice"),
    );
    expect(dispatchEscalation).not.toHaveBeenCalled();

    deps.now = () => 240_000;
    fixed = rec.sweepLeaderAcknowledgements(deps);

    expect(fixed).toBe(1);
    const updated = reg.getSession(child.id);
    expect(ack.readLeaderAckMeta(updated)).toMatchObject({
      state: "escalated",
      escalatedTo: "manual-review",
    });
    expect(dispatchEscalation).not.toHaveBeenCalled();
    expect(reg.getMessages(child.id).some((message) => message.content.includes("Escalated to manual human review"))).toBe(true);
  });

  it("does not escalate when the supervisor replies after the second contact", () => {
    const parent = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:parent-reminder-ack",
      prompt: "parent",
      employee: "software-delivery-lead",
    });
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child-reminder-ack",
      prompt: "child",
      employee: "engineer",
      parentSessionId: parent.id,
    });
    ack.markLeaderAckPending(child, {
      leaderSessionId: parent.id,
      leaderName: "software-delivery-lead",
      reportKind: "result",
      now: new Date(0).toISOString(),
    });
    const dispatchParentReminder = vi.fn(async () => {});
    const getConfig = () => ({
      gateway: { port: 8888, host: "127.0.0.1", leaderAckTimeoutMs: 60_000 },
      engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
      connectors: {},
      logging: { file: true, stdout: true, level: "info" },
    } as any);

    expect(rec.sweepLeaderAcknowledgements({
      emit: vi.fn(),
      getConfig,
      now: () => 120_000,
      dispatchParentReminder,
    })).toBe(0);
    reg.insertMessage(parent.id, "assistant", "I reviewed the report and am handling the follow-up now.");

    expect(rec.sweepLeaderAcknowledgements({
      emit: vi.fn(),
      getConfig,
      now: () => 240_000,
      dispatchParentReminder,
    })).toBe(0);
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "acknowledged",
      contactAttemptCount: 2,
      acknowledgedBy: "software-delivery-lead",
    });
  });

  it("acknowledges instead of escalating when the parent already marked the child report no-op", async () => {
    const parent = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:parent-noop",
      prompt: "parent",
      employee: "software-delivery-lead",
    });
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child-noop",
      prompt: "child",
      employee: "execution-safety-reviewer",
      parentSessionId: parent.id,
    });
    ack.markLeaderAckPending(child, {
      leaderSessionId: parent.id,
      leaderName: "software-delivery-lead",
      reportKind: "result",
      now: new Date(0).toISOString(),
    });
    reg.insertMessage(parent.id, "assistant", "Ignoring this stale acknowledgement loop. Task is closed.");

    const dispatchEscalation = vi.fn(async () => {});
    const fixed = rec.sweepLeaderAcknowledgements({
      emit: vi.fn(),
      getConfig: () => ({
        gateway: { port: 8888, host: "127.0.0.1", leaderAckTimeoutMs: 60_000 },
        engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
        connectors: {},
        logging: { file: true, stdout: true, level: "info" },
      } as any),
      now: () => 120_000,
      dispatchEscalation,
    });

    expect(fixed).toBe(0);
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "acknowledged",
      acknowledgedBy: "software-delivery-lead",
    });
    expect(dispatchEscalation).not.toHaveBeenCalled();
    expect(reg.getMessages(child.id).some((message) => message.content.includes("Leader acknowledgement timeout"))).toBe(false);
  });

  it("acknowledges when the leader simply relays the report in a normal assistant reply (no explicit ack call)", async () => {
    const parent = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:parent-relay",
      prompt: "parent",
      employee: "research-lead",
    });
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child-relay",
      prompt: "child",
      employee: "researcher",
      parentSessionId: parent.id,
    });
    ack.markLeaderAckPending(child, {
      leaderSessionId: parent.id,
      leaderName: "research-lead",
      reportKind: "result",
      now: new Date(0).toISOString(),
    });
    // Ordinary relay: the leader just tells the user what the worker found —
    // no boilerplate "acknowledged" phrase, no explicit ack API call.
    reg.insertMessage(parent.id, "assistant", "The vampire squid fact came back from research: it lives in the midnight zone.");

    const dispatchEscalation = vi.fn(async () => {});
    const fixed = rec.sweepLeaderAcknowledgements({
      emit: vi.fn(),
      getConfig: () => ({
        gateway: { port: 8888, host: "127.0.0.1", leaderAckTimeoutMs: 60_000 },
        engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
        connectors: {},
        logging: { file: true, stdout: true, level: "info" },
      } as any),
      now: () => 120_000,
      dispatchEscalation,
    });

    expect(fixed).toBe(0);
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "acknowledged",
      acknowledgedBy: "research-lead",
    });
    expect(dispatchEscalation).not.toHaveBeenCalled();
  });

  it("marks the leader ack acknowledged when the child receives a real follow-up", () => {
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child-ack",
      prompt: "child",
      employee: "assistant",
      parentSessionId: "parent-ack",
    });
    ack.markLeaderAckPending(child, {
      leaderSessionId: "parent-ack",
      leaderName: "boss",
      reportKind: "result",
      now: new Date(0).toISOString(),
    });

    const changed = ack.acknowledgeLeaderAck(child.id, reg.getSession(child.id), {
      acknowledgedBy: "boss",
      now: new Date(30_000).toISOString(),
    });

    expect(changed).toBe(true);
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "acknowledged",
      acknowledgedBy: "boss",
    });
  });

  it("suppresses a second escalation on the same session lineage instead of re-paging HR (repro: HR closing-ack loop)", async () => {
    const parent = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:parent-loop",
      prompt: "parent",
      employee: "coo",
    });
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child-loop",
      prompt: "child",
      employee: "scraping-lead",
      parentSessionId: parent.id,
    });

    const getConfig = () => ({
      gateway: { port: 8888, host: "127.0.0.1", leaderAckTimeoutMs: 60_000 },
      engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
      connectors: {},
      logging: { file: true, stdout: true, level: "info" },
    } as any);

    // Round 1: worker reports, the reminder timeout fires, then the second
    // unanswered timeout escalates.
    ack.markLeaderAckPending(child, {
      leaderSessionId: parent.id,
      leaderName: "coo",
      reportKind: "result",
      now: new Date(0).toISOString(),
    });
    const dispatchEscalation = vi.fn(async () => {});
    const reminderDeps = {
      emit: vi.fn(),
      getConfig,
      now: () => 120_000,
      dispatchEscalation,
    };
    let escalated = rec.sweepLeaderAcknowledgements(reminderDeps);
    expect(escalated).toBe(0);
    reminderDeps.now = () => 240_000;
    escalated = rec.sweepLeaderAcknowledgements(reminderDeps);
    expect(escalated).toBe(1);
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "escalated",
      escalationCount: 1,
    });

    // Round 2: HR sends a closing message into the worker session; the worker's
    // reply re-arms a fresh pending cycle via markLeaderAckPending (this is the
    // notifyParentSession path — simulated directly here since that's the exact
    // re-arm this reconciler must dedupe against).
    ack.markLeaderAckPending(reg.getSession(child.id)!, {
      leaderSessionId: parent.id,
      leaderName: "coo",
      reportKind: "result",
      now: new Date(250_000).toISOString(),
    });
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "pending",
      escalationCount: 1, // carried forward, not reset
    });

    escalated = rec.sweepLeaderAcknowledgements({
      emit: vi.fn(),
      getConfig,
      now: () => 370_000,
      dispatchEscalation,
    });

    expect(escalated).toBe(0);
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "pending",
      contactAttemptCount: 2,
    });

    escalated = rec.sweepLeaderAcknowledgements({
      emit: vi.fn(),
      getConfig,
      now: () => 490_000,
      dispatchEscalation,
    });

    // Must NOT repeat a manual-review escalation for the same session lineage.
    expect(escalated).toBe(0);
    expect(dispatchEscalation).not.toHaveBeenCalled();
    expect(ack.readLeaderAckMeta(reg.getSession(child.id))).toMatchObject({
      state: "acknowledged",
    });
  });
});
