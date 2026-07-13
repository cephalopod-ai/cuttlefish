import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveTalkRoot,
  buildGraphSnapshot,
  maybeEmitTalkGraph,
  emitAttachmentChange,
  toGraphNode,
} from "../graph.js";
import { attach, __resetAttachmentsForTest } from "../attachments.js";
import type { Session } from "../../shared/types.js";

function s(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    engine: "claude",
    engineSessionId: null,
    source: "web",
    sourceRef: "web:main",
    connector: "web",
    sessionKey: id,
    employee: null,
    model: null,
    title: null,
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

const sessions = new Map<string, Session>();
const getSession = (id: string) => sessions.get(id);
const listChildSessions = (pid: string) =>
  [...sessions.values()].filter((x) => x.parentSessionId === pid);

function seedTree() {
  sessions.clear();
  sessions.set("root", s("root", { source: "talk" }));
  sessions.set("coo1", s("coo1", { parentSessionId: "root", title: "Content", status: "running" }));
  sessions.set("coo2", s("coo2", { parentSessionId: "root", title: "Support" }));
  sessions.set("emp1", s("emp1", { parentSessionId: "coo1", title: null, employee: "content-lead", status: "running" }));
}

describe("resolveTalkRoot", () => {
  it("walks any depth up to the talk root", () => {
    seedTree();
    expect(resolveTalkRoot("emp1", getSession)?.id).toBe("root");
    expect(resolveTalkRoot("coo2", getSession)?.id).toBe("root");
    expect(resolveTalkRoot("root", getSession)?.id).toBe("root");
  });
  it("returns undefined for non-talk trees and cycles", () => {
    seedTree();
    sessions.set("loner", s("loner"));
    expect(resolveTalkRoot("loner", getSession)).toBeUndefined();
    sessions.set("a", s("a", { parentSessionId: "b" }));
    sessions.set("b", s("b", { parentSessionId: "a" }));
    expect(resolveTalkRoot("a", getSession)).toBeUndefined();
  });
});

describe("buildGraphSnapshot", () => {
  it("returns all descendants with depth, labels, status", () => {
    seedTree();
    const nodes = buildGraphSnapshot("root", listChildSessions);
    expect(nodes).toHaveLength(3);
    const emp = nodes.find((n) => n.id === "emp1")!;
    expect(emp.depth).toBe(2);
    expect(emp.parentId).toBe("coo1");
    expect(emp.label).toBe("content-lead"); // employee fallback when no title
    const coo = nodes.find((n) => n.id === "coo1")!;
    expect(coo.depth).toBe(1);
    expect(coo.label).toBe("Content");
    expect(coo.status).toBe("running");
  });
});

describe("briefExcerpt", () => {
  const base = s("c1", { parentSessionId: "root", title: "Lead", status: "running" });

  it("carries the session's persisted promptExcerpt", () => {
    const sess = { ...base, promptExcerpt: "Audit the funnel and split the fixes" } as Session;
    expect(toGraphNode(sess, 1).briefExcerpt).toBe("Audit the funnel and split the fixes");
  });

  it("omits the field when the session has no promptExcerpt", () => {
    expect(toGraphNode(base, 1).briefExcerpt).toBeUndefined();
    const sess = { ...base, promptExcerpt: null } as Session;
    expect(toGraphNode(sess, 1).briefExcerpt).toBeUndefined();
  });
});

describe("maybeEmitTalkGraph", () => {
  it("emits talk:graph for sessions inside a talk tree", () => {
    seedTree();
    const emit = vi.fn();
    maybeEmitTalkGraph("emp1", "added", { getSession, emit });
    expect(emit).toHaveBeenCalledTimes(1);
    const [event, payload] = emit.mock.calls[0];
    expect(event).toBe("talk:graph");
    expect(payload.rootId).toBe("root");
    expect(payload.change).toBe("added");
    expect(payload.node.id).toBe("emp1");
    expect(payload.node.depth).toBe(2);
  });
  it("stays silent outside talk trees", () => {
    seedTree();
    sessions.set("loner", s("loner"));
    const emit = vi.fn();
    maybeEmitTalkGraph("loner", "completed", { getSession, emit });
    expect(emit).not.toHaveBeenCalled();
  });
});

// In-memory attachment deps for seeding the real attachments module.
const attachDeps = {
  getSession,
  patchSessionMeta: () => {},
};

describe("attachment nodes in buildGraphSnapshot", () => {
  beforeEach(() => __resetAttachmentsForTest());

  it("appends an attachment as a depth-1 node with attached/mode + label", () => {
    seedTree();
    // An external session (parent goes elsewhere), attached to the talk root.
    sessions.set("ext", s("ext", { parentSessionId: "elsewhere", title: "Audit job" }));
    attach("root", "ext", "engage", attachDeps);

    const nodes = buildGraphSnapshot("root", listChildSessions, {
      getSession,
      listAttachments: (talkId) => (talkId === "root" ? [{ targetId: "ext", mode: "engage" }] : []),
    });
    const att = nodes.find((n) => n.id === "ext")!;
    expect(att).toBeDefined();
    expect(att.depth).toBe(1);
    expect(att.attached).toBe(true);
    expect(att.mode).toBe("engage");
    expect(att.parentId).toBe("root"); // renders as a satellite of the talk root
    expect(att.label).toBe("Audit job");
    // Owned descendants still present.
    expect(nodes.some((n) => n.id === "coo1")).toBe(true);
    expect(nodes.some((n) => n.id === "emp1")).toBe(true);
  });

  it("falls back to employee label when an attached session has no title", () => {
    seedTree();
    sessions.set("ext", s("ext", { parentSessionId: "elsewhere", title: null, employee: "auditor" }));
    const nodes = buildGraphSnapshot("root", listChildSessions, {
      getSession,
      listAttachments: () => [{ targetId: "ext", mode: "observe" }],
    });
    expect(nodes.find((n) => n.id === "ext")!.label).toBe("auditor");
  });

  it("does NOT duplicate an attachment that is also a descendant (descendant wins)", () => {
    seedTree();
    // emp1 is a descendant (under coo1) AND attached to root.
    const nodes = buildGraphSnapshot("root", listChildSessions, {
      getSession,
      listAttachments: () => [{ targetId: "emp1", mode: "observe" }],
    });
    const emp = nodes.filter((n) => n.id === "emp1");
    expect(emp).toHaveLength(1);
    expect(emp[0].depth).toBe(2); // true descendant depth, not an attachment node
    expect(emp[0].attached).toBeUndefined();
  });
});

describe("maybeEmitTalkGraph — attachment membership", () => {
  beforeEach(() => __resetAttachmentsForTest());

  it("emits a talk:graph delta to the attaching root when an ATTACHED (non-descendant) session changes", () => {
    seedTree();
    sessions.set("ext", s("ext", { parentSessionId: "elsewhere", title: "Audit job" }));
    attach("root", "ext", "engage", attachDeps);

    const emit = vi.fn();
    maybeEmitTalkGraph("ext", "status", { getSession, emit });
    expect(emit).toHaveBeenCalledTimes(1);
    const [event, payload] = emit.mock.calls[0];
    expect(event).toBe("talk:graph");
    expect(payload.rootId).toBe("root");
    expect(payload.change).toBe("status");
    expect(payload.node.id).toBe("ext");
    expect(payload.node.depth).toBe(1);
    expect(payload.node.attached).toBe(true);
    expect(payload.node.mode).toBe("engage");
  });

  it("emits BOTH a descendant delta and attachment deltas to OTHER roots", () => {
    seedTree();
    // A second talk root attaches emp1 (which is a descendant of root via coo1).
    sessions.set("root2", s("root2", { source: "talk" }));
    attach("root2", "emp1", "observe", attachDeps);

    const emit = vi.fn();
    maybeEmitTalkGraph("emp1", "status", { getSession, emit });
    expect(emit).toHaveBeenCalledTimes(2);
    const roots = emit.mock.calls.map((c) => c[1].rootId).sort();
    expect(roots).toEqual(["root", "root2"]);
    const root2Delta = emit.mock.calls.find((c) => c[1].rootId === "root2")![1];
    expect(root2Delta.node.attached).toBe(true);
    const rootDelta = emit.mock.calls.find((c) => c[1].rootId === "root")![1];
    expect(rootDelta.node.attached).toBeUndefined(); // descendant node
    expect(rootDelta.node.depth).toBe(2);
  });

  it("does NOT double-emit when a session is attached to its own descendant root (descendant wins)", () => {
    seedTree();
    attach("root", "emp1", "observe", attachDeps); // emp1 already a descendant of root
    const emit = vi.fn();
    maybeEmitTalkGraph("emp1", "status", { getSession, emit });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1].node.attached).toBeUndefined();
  });
});

describe("emitAttachmentChange", () => {
  it("emits an attached/detached delta with an attachment node", () => {
    seedTree();
    const target = s("ext", { parentSessionId: "elsewhere", title: "Audit job" });
    const emit = vi.fn();
    emitAttachmentChange("root", target, "attached", "engage", emit);
    expect(emit).toHaveBeenCalledTimes(1);
    const [event, payload] = emit.mock.calls[0];
    expect(event).toBe("talk:graph");
    expect(payload).toMatchObject({
      rootId: "root",
      change: "attached",
      node: { id: "ext", depth: 1, attached: true, mode: "engage", parentId: "root" },
    });
  });
});
