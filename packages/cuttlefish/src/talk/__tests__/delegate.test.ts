import { describe, it, expect, vi } from "vitest";
import { delegateToThread, type DelegateDeps } from "../delegate.js";
import type { Attachment } from "../attachments.js";
import type { Session } from "../../shared/types.js";

function fakeSession(over: Partial<Session>): Session {
  return {
    id: "t1",
    engine: "claude",
    engineSessionId: null,
    source: "talk",
    sourceRef: "talk:main",
    connector: "web",
    sessionKey: "talk:main",
    employee: null,
    model: null,
    title: "Talk",
    parentSessionId: null,
    userId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    replyContext: null,
    messageId: null,
    transportMeta: null,
    createdAt: "2026-06-10T00:00:00Z",
    lastActivity: "2026-06-10T00:00:00Z",
    lastError: null,
    ...over,
  } as Session;
}

/** In-memory fake of the attachments module, injected into DelegateDeps. */
function fakeAttachments(initial: Attachment[] = []) {
  const map = new Map<string, Attachment>(initial.map((a) => [a.targetId, a]));
  return {
    attach: vi.fn((_talkId: string, targetId: string, mode: "observe" | "engage") => {
      if (!map.has(targetId) && map.size >= 5) {
        return { ok: false as const, error: "attachment cap reached (5)" };
      }
      const attachment: Attachment = { targetId, mode, since: 123 };
      map.set(targetId, attachment);
      return { ok: true as const, attachment };
    }),
    detach: vi.fn((_talkId: string, targetId: string) => map.delete(targetId)),
    list: vi.fn((_talkId: string) => [...map.values()]),
  };
}

function deps(over: Partial<DelegateDeps> = {}): DelegateDeps {
  return {
    getSession: (id) => (id === "t1" ? fakeSession({}) : undefined),
    listChildSessions: () => [
      fakeSession({ id: "c1", source: "web", parentSessionId: "t1", title: "Content" }),
    ],
    spawnChild: vi.fn(async () => ({ id: "new-child" })),
    continueThread: vi.fn(async () => {}),
    updateSession: vi.fn(),
    emit: vi.fn(),
    attachments: fakeAttachments(),
    ...over,
  };
}

describe("delegateToThread", () => {
  it("spawns a new COO child with thread:'new', sets title, emits thread label", async () => {
    const d = deps();
    const r = await delegateToThread(
      { sessionId: "t1", thread: "new", label: "Content pipeline", brief: "Run phase 2" },
      d,
    );
    expect(r).toEqual({ ok: true, threadId: "new-child", created: true });
    expect(d.spawnChild).toHaveBeenCalledWith({ prompt: "Run phase 2", parentSessionId: "t1" });
    expect(d.updateSession).toHaveBeenCalledWith("new-child", { title: "Content pipeline" });
    expect(d.emit).toHaveBeenCalledWith("talk:thread:label", {
      sessionId: "t1",
      threadId: "new-child",
      label: "Content pipeline",
    });
  });

  it("continues an existing child thread", async () => {
    const d = deps({
      getSession: (id) =>
        id === "t1"
          ? fakeSession({})
          : id === "c1"
            ? fakeSession({ id: "c1", source: "web", parentSessionId: "t1", title: "Content" })
            : undefined,
    });
    const r = await delegateToThread({ sessionId: "t1", thread: "c1", brief: "Follow up" }, d);
    expect(r).toEqual({ ok: true, threadId: "c1", created: false });
    expect(d.continueThread).toHaveBeenCalledWith("c1", "Follow up");
  });

  it("rejects an unknown thread id with the live roster", async () => {
    const r = await delegateToThread({ sessionId: "t1", thread: "nope", brief: "x" }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.threads).toEqual([{ id: "c1", label: "Content", status: "idle" }]);
    }
  });

  it("rejects a non-talk sessionId", async () => {
    const d = deps({ getSession: () => fakeSession({ id: "w1", source: "web" }) });
    const r = await delegateToThread({ sessionId: "w1", thread: "new", brief: "x" }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects empty brief and missing sessionId", async () => {
    expect(
      (await delegateToThread({ sessionId: "t1", thread: "new", brief: "  " }, deps())).ok,
    ).toBe(false);
    expect((await delegateToThread({ thread: "new", brief: "x" }, deps())).ok).toBe(false);
  });

  it("defaults the label from the brief when omitted on a new thread", async () => {
    const d = deps();
    await delegateToThread(
      { sessionId: "t1", thread: "new", brief: "Check the pipeline order status please" },
      d,
    );
    // Brief is 37 chars → slice(0,35).trimEnd() + "…"
    expect(d.updateSession).toHaveBeenCalledWith("new-child", {
      title: "Check the pipeline order status ple…",
    });
  });

  it("rejects continuing a child that belongs to a DIFFERENT talk session", async () => {
    const d = deps({
      getSession: (id) =>
        id === "t1"
          ? fakeSession({})
          : id === "foreign"
            ? fakeSession({ id: "foreign", source: "web", parentSessionId: "other-talk", title: "Foreign" })
            : undefined,
    });
    const r = await delegateToThread({ sessionId: "t1", thread: "foreign", brief: "x" }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.threads).toEqual([{ id: "c1", label: "Content", status: "idle" }]);
    }
    expect(d.continueThread).not.toHaveBeenCalled();
  });

  // ── utterance composition (owned children) ─────────────────────────────
  const VERBATIM =
    '\n\n---\nOperator\'s original request (verbatim): "do the thing now"\n' +
    "If the brief above misreads this, the original words win.";

  it("appends the verbatim block (no provenance prefix) on a NEW owned thread", async () => {
    const d = deps();
    await delegateToThread(
      { sessionId: "t1", thread: "new", brief: "Run phase 2", utterance: "do the thing now" },
      d,
    );
    expect(d.spawnChild).toHaveBeenCalledWith({
      prompt: "Run phase 2" + VERBATIM,
      parentSessionId: "t1",
      promptExcerpt: "do the thing now",
    });
  });

  it("passes the operator's utterance as promptExcerpt so the brief excerpt shows the ask, not scaffolding", async () => {
    const d = deps();
    await delegateToThread(
      { sessionId: "t1", thread: "new", brief: "Run phase 2", utterance: "do the thing now" },
      d,
    );
    const call = (d.spawnChild as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.promptExcerpt).toBe("do the thing now");
  });

  it("omits promptExcerpt when there is no utterance (excerpt falls back to the prompt)", async () => {
    const d = deps();
    await delegateToThread({ sessionId: "t1", thread: "new", brief: "Run phase 2" }, d);
    const call = (d.spawnChild as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.promptExcerpt).toBeUndefined();
  });

  it("appends the verbatim block on a CONTINUED owned thread", async () => {
    const d = deps({
      getSession: (id) =>
        id === "t1"
          ? fakeSession({})
          : id === "c1"
            ? fakeSession({ id: "c1", source: "web", parentSessionId: "t1", title: "Content" })
            : undefined,
    });
    await delegateToThread(
      { sessionId: "t1", thread: "c1", brief: "Follow up", utterance: "do the thing now" },
      d,
    );
    expect(d.continueThread).toHaveBeenCalledWith("c1", "Follow up" + VERBATIM);
  });

  it("omits the verbatim block when no utterance (back-compat)", async () => {
    const d = deps();
    await delegateToThread({ sessionId: "t1", thread: "new", brief: "Run phase 2" }, d);
    expect(d.spawnChild).toHaveBeenCalledWith({ prompt: "Run phase 2", parentSessionId: "t1" });
  });

  // ── attach ─────────────────────────────────────────────────────────────
  function attachDeps(over: Partial<DelegateDeps> = {}): DelegateDeps {
    return deps({
      getSession: (id) =>
        id === "t1"
          ? fakeSession({})
          : id === "emp"
            ? fakeSession({ id: "emp", source: "web", parentSessionId: "someone-else", title: "Content" })
            : id === "talk2"
              ? fakeSession({ id: "talk2", source: "talk" })
              : undefined,
      ...over,
    });
  }

  it("attaches a non-owned session in observe mode (skips parent-ownership check)", async () => {
    const d = attachDeps();
    const r = await delegateToThread({ sessionId: "t1", attach: true, thread: "emp" }, d);
    expect(r).toEqual({ ok: true, threadId: "emp", attached: true, mode: "observe" });
    expect(d.attachments.attach).toHaveBeenCalledWith("t1", "emp", "observe");
    expect(d.continueThread).not.toHaveBeenCalled();
  });

  it("attach engage WITH brief relays a provenance-prefixed message", async () => {
    const d = attachDeps();
    const r = await delegateToThread(
      {
        sessionId: "t1",
        attach: true,
        thread: "emp",
        mode: "engage",
        brief: "Ship the fix",
        utterance: "do the thing now",
      },
      d,
    );
    expect(r).toEqual({ ok: true, threadId: "emp", attached: true, mode: "engage" });
    expect(d.continueThread).toHaveBeenCalledTimes(1);
    const [target, msg] = (d.continueThread as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(target).toBe("emp");
    expect(msg).toBe(
      "[Relayed by AURA on behalf of the operator]\n\nShip the fix" + VERBATIM,
    );
  });

  it("attach engage WITHOUT utterance is just prefix + brief", async () => {
    const d = attachDeps();
    await delegateToThread(
      { sessionId: "t1", attach: true, thread: "emp", mode: "engage", brief: "Ship the fix" },
      d,
    );
    const [, msg] = (d.continueThread as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toBe("[Relayed by AURA on behalf of the operator]\n\nShip the fix");
  });

  it("attach observe WITH a brief is a 400 (observe can't send messages)", async () => {
    const d = attachDeps();
    const r = await delegateToThread(
      { sessionId: "t1", attach: true, thread: "emp", mode: "observe", brief: "Ship it" },
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toMatch(/observe mode cannot send messages/);
    }
    expect(d.attachments.attach).not.toHaveBeenCalled();
    expect(d.continueThread).not.toHaveBeenCalled();
  });

  it("rejects attaching a talk session", async () => {
    const d = attachDeps();
    const r = await delegateToThread({ sessionId: "t1", attach: true, thread: "talk2" }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(d.attachments.attach).not.toHaveBeenCalled();
  });

  it("rejects attaching a non-existent target", async () => {
    const d = attachDeps();
    const r = await delegateToThread({ sessionId: "t1", attach: true, thread: "ghost" }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects attaching an already-attached target", async () => {
    const d = attachDeps({
      attachments: fakeAttachments([{ targetId: "emp", mode: "observe", since: 1 }]),
    });
    const r = await delegateToThread({ sessionId: "t1", attach: true, thread: "emp" }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("surfaces the attachments cap error as a 400", async () => {
    const five = [0, 1, 2, 3, 4].map((i) => ({
      targetId: `x${i}`,
      mode: "observe" as const,
      since: 1,
    }));
    const d = attachDeps({ attachments: fakeAttachments(five) });
    const r = await delegateToThread({ sessionId: "t1", attach: true, thread: "emp" }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toMatch(/cap/i);
    }
  });

  // ── detach ─────────────────────────────────────────────────────────────
  it("detaches an existing attachment (no message sent)", async () => {
    const d = attachDeps({
      attachments: fakeAttachments([{ targetId: "emp", mode: "engage", since: 1 }]),
    });
    const r = await delegateToThread({ sessionId: "t1", detach: true, thread: "emp" }, d);
    expect(r).toEqual({ ok: true, threadId: "emp", detached: true });
    expect(d.attachments.detach).toHaveBeenCalledWith("t1", "emp");
    expect(d.continueThread).not.toHaveBeenCalled();
  });

  it("detach of an unknown attachment 400s with the current roster", async () => {
    const d = attachDeps({
      attachments: fakeAttachments([{ targetId: "other", mode: "observe", since: 1 }]),
    });
    const r = await delegateToThread({ sessionId: "t1", detach: true, thread: "emp" }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.attachments).toEqual([{ targetId: "other", mode: "observe", since: 1 }]);
    }
    expect(d.attachments.detach).not.toHaveBeenCalled();
  });

  // ── graph delta emission (attached / detached) ──────────────────────────
  it("emits an 'attached' graph delta on a successful attach", async () => {
    const emitAttachmentChange = vi.fn();
    const d = attachDeps({ emitAttachmentChange });
    await delegateToThread({ sessionId: "t1", attach: true, thread: "emp", mode: "engage" }, d);
    expect(emitAttachmentChange).toHaveBeenCalledTimes(1);
    const [rootId, target, change, mode] = emitAttachmentChange.mock.calls[0];
    expect(rootId).toBe("t1");
    expect(target.id).toBe("emp");
    expect(change).toBe("attached");
    expect(mode).toBe("engage");
  });

  it("emits a 'detached' graph delta (with the prior mode) on a successful detach", async () => {
    const emitAttachmentChange = vi.fn();
    const d = attachDeps({
      attachments: fakeAttachments([{ targetId: "emp", mode: "engage", since: 1 }]),
      emitAttachmentChange,
    });
    await delegateToThread({ sessionId: "t1", detach: true, thread: "emp" }, d);
    expect(emitAttachmentChange).toHaveBeenCalledTimes(1);
    const [rootId, target, change, mode] = emitAttachmentChange.mock.calls[0];
    expect(rootId).toBe("t1");
    expect(target.id).toBe("emp");
    expect(change).toBe("detached");
    expect(mode).toBe("engage");
  });

  it("does not emit a graph delta when attach is rejected (cap reached)", async () => {
    const emitAttachmentChange = vi.fn();
    const five = [0, 1, 2, 3, 4].map((i) => ({ targetId: `x${i}`, mode: "observe" as const, since: 1 }));
    const d = attachDeps({ attachments: fakeAttachments(five), emitAttachmentChange });
    await delegateToThread({ sessionId: "t1", attach: true, thread: "emp" }, d);
    expect(emitAttachmentChange).not.toHaveBeenCalled();
  });
});
