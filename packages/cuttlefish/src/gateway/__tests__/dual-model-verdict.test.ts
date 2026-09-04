/**
 * Guards for the dual-model verdict primitive's parsing + fail-closed rules
 * (gateway/dual-model-verdict.ts). The engine-spawning path is exercised at
 * runtime (see the autonomous-mode plan's verification steps); these tests
 * pin the deterministic core: verdict validation, the parent-session guard,
 * and per-rung error containment (an unavailable engine must yield a
 * structured `error` verdict for that rung — never a rejected promise that
 * loses the other rung's audit trail).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../sessions/registry.js", () => ({
  createSession: vi.fn(),
  getMessages: vi.fn(() => []),
  getSession: vi.fn(),
  insertMessage: vi.fn(),
}));
vi.mock("../api/session-dispatch.js", () => ({
  dispatchWebSessionRun: vi.fn(),
  killSessionEngines: vi.fn(),
}));
vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { requestDualModelVerdict, validateAutonomousVerdict } from "../dual-model-verdict.js";
import { createSession, getMessages, getSession } from "../../sessions/registry.js";
import { dispatchWebSessionRun } from "../api/session-dispatch.js";
import type { ApiContext } from "../api/context.js";

describe("validateAutonomousVerdict", () => {
  it("accepts a plain JSON approval and rejection", () => {
    expect(validateAutonomousVerdict('{"approved": true, "reason": "safe"}')).toEqual({
      ok: true,
      value: { approved: true, reason: "safe" },
    });
    expect(validateAutonomousVerdict('{"approved": false, "reason": "risky"}')).toEqual({
      ok: true,
      value: { approved: false, reason: "risky" },
    });
  });

  it("accepts a fenced ```json block (models love fences despite instructions)", () => {
    expect(validateAutonomousVerdict('```json\n{"approved": true, "reason": "ok"}\n```')).toEqual({
      ok: true,
      value: { approved: true, reason: "ok" },
    });
  });

  it("defaults a missing/non-string reason to empty, never to invented text", () => {
    expect(validateAutonomousVerdict('{"approved": true}')).toEqual({
      ok: true,
      value: { approved: true, reason: "" },
    });
    expect(validateAutonomousVerdict('{"approved": true, "reason": 42}')).toEqual({
      ok: true,
      value: { approved: true, reason: "" },
    });
  });

  it("rejects empty, prose, non-object, and missing-boolean responses", () => {
    expect(validateAutonomousVerdict("")).toEqual({ ok: false, error: "verdict response was empty" });
    expect(validateAutonomousVerdict("   ")).toEqual({ ok: false, error: "verdict response was empty" });
    expect(validateAutonomousVerdict("ALLOW — this command is fine.").ok).toBe(false);
    expect(validateAutonomousVerdict("[true]").ok).toBe(false);
    expect(validateAutonomousVerdict('"approved"').ok).toBe(false);
    expect(validateAutonomousVerdict('{"approved": "yes"}').ok).toBe(false);
    expect(validateAutonomousVerdict('{"reason": "no verdict field"}').ok).toBe(false);
  });
});

describe("requestDualModelVerdict — fail-closed structure", () => {
  it.each([true, false])("dispatches fixed Fable/Astra judge sessions and requires both approvals (Astra approves: %s)", async (astraApproves) => {
    vi.mocked(createSession).mockClear();
    vi.mocked(dispatchWebSessionRun).mockClear();
    vi.mocked(getSession).mockImplementation((id) => ({ id, source: "web", connector: "web", status: "idle" }) as never);
    vi.mocked(createSession).mockImplementation((input) => ({ ...input, id: `judge-${input.engine}` }) as never);
    vi.mocked(getMessages).mockImplementation((id) => [{
      role: "assistant", partial: false,
      content: JSON.stringify({ approved: id !== "judge-codex" || astraApproves, reason: "reviewed" }),
    }] as never);
    vi.mocked(dispatchWebSessionRun).mockResolvedValue(undefined);
    const context = {
      sessionManager: { getEngine: vi.fn(() => ({})) },
      getConfig: vi.fn(() => ({ portal: {}, engines: { codex: { model: "gpt-5.6-terra" } } })),
    } as unknown as ApiContext;
    const result = await requestDualModelVerdict(
      { parentSessionId: "parent", cwd: "/tmp", decisionKind: "org_change", contextPrompt: "review" }, context,
    );
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      engine: "codex", model: "gpt-6-astra", transportMeta: { autonomousVerdictSession: true },
    }));
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ engine: "claude", model: "claude-fable-5-1" }));
    expect(dispatchWebSessionRun).toHaveBeenCalledTimes(2);
    expect(result.authorized).toBe(astraApproves);
    expect(result.codex.rung).toBe("gpt-6-astra");
  });

  it("returns structured, unauthorized error verdicts when the parent session is missing", async () => {
    vi.mocked(getSession).mockReturnValue(undefined);
    const result = await requestDualModelVerdict(
      { parentSessionId: "nope", cwd: "/tmp", decisionKind: "tool_checkpoint", contextPrompt: "ctx" },
      {} as ApiContext,
    );
    expect(result.authorized).toBe(false);
    expect(result.claude).toMatchObject({ rung: "claude-fable-5-1", outcome: "error" });
    expect(result.codex).toMatchObject({ rung: "gpt-6-astra", outcome: "error" });
  });

  it("contains an unavailable engine to a per-rung error verdict — both rungs still report", async () => {
    vi.mocked(getSession).mockReturnValue({
      id: "parent-1",
      source: "web",
      title: "t",
      connector: "web",
    } as never);
    const context = {
      sessionManager: { getEngine: vi.fn(() => undefined) },
      getConfig: vi.fn(() => ({})),
    } as unknown as ApiContext;
    const result = await requestDualModelVerdict(
      { parentSessionId: "parent-1", cwd: "/tmp", decisionKind: "org_change", contextPrompt: "ctx" },
      context,
    );
    // Fail-closed: no engines → no authorization, but BOTH rungs return a
    // structured error verdict for the audit trail instead of one rejection
    // wiping out the whole result.
    expect(result.authorized).toBe(false);
    expect(result.claude.outcome).toBe("error");
    expect(result.codex.outcome).toBe("error");
    expect(result.claude.reason).toContain("not available");
    expect(result.codex.reason).toContain("not available");
  });
});
