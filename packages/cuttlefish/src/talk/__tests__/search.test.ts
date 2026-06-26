import { describe, it, expect } from "vitest";
import { searchTalkSessions, type SearchDeps } from "../search.js";
import type { Session } from "../../shared/types.js";
import type { MessageSearchResult } from "../../sessions/registry.js";

function makeSession(id: string, over: Partial<Session> = {}): Session {
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
    title: `Session ${id}`,
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

function makeDeps(over: Partial<SearchDeps> = {}): SearchDeps {
  return {
    searchSessions: () => [],
    searchMessages: () => [],
    getSession: () => undefined,
    resolveTalkRoot: () => undefined,
    ...over,
  };
}

describe("searchTalkSessions", () => {
  describe("input validation", () => {
    it("rejects empty string q", () => {
      const r = searchTalkSessions("", makeDeps());
      expect(r).toEqual({ ok: false, status: 400, error: "q must be a non-empty string" });
    });

    it("rejects whitespace-only q", () => {
      const r = searchTalkSessions("   ", makeDeps());
      expect(r).toEqual({ ok: false, status: 400, error: "q must be a non-empty string" });
    });

    it("rejects non-string q", () => {
      const r = searchTalkSessions(null, makeDeps());
      expect(r).toEqual({ ok: false, status: 400, error: "q must be a non-empty string" });

      const r2 = searchTalkSessions(undefined, makeDeps());
      expect(r2).toEqual({ ok: false, status: 400, error: "q must be a non-empty string" });

      const r3 = searchTalkSessions(42, makeDeps());
      expect(r3).toEqual({ ok: false, status: 400, error: "q must be a non-empty string" });
    });
  });

  describe("happy path — title hits only", () => {
    it("returns sessions with empty hits array when no message hits", () => {
      const s1 = makeSession("s1", { title: "Build pipeline", employee: null });
      const s2 = makeSession("s2", { title: "Support queue", employee: "support-lead" });
      const deps = makeDeps({
        searchSessions: () => [s1, s2],
        searchMessages: () => [],
        getSession: (id) => (id === "s1" ? s1 : id === "s2" ? s2 : undefined),
      });
      const r = searchTalkSessions("support", deps);
      expect(r).toEqual({
        ok: true,
        results: [
          {
            sessionId: "s1",
            title: "Build pipeline",
            employee: null,
            source: "web",
            lastActivity: "2026-06-10T00:00:00Z",
            status: "idle",
            isTalkChild: false,
            hits: [],
          },
          {
            sessionId: "s2",
            title: "Support queue",
            employee: "support-lead",
            source: "web",
            lastActivity: "2026-06-10T00:00:00Z",
            status: "idle",
            isTalkChild: false,
            hits: [],
          },
        ],
      });
    });

    it("passes trimmed query to searchSessions", () => {
      let captured = "";
      const deps = makeDeps({
        searchSessions: (q) => { captured = q; return []; },
      });
      searchTalkSessions("  hello world  ", deps);
      expect(captured).toBe("hello world");
    });
  });

  describe("happy path — content hits only", () => {
    it("returns sessions from message hits with populated hits array", () => {
      const session = makeSession("s1");
      const messageHits: MessageSearchResult[] = [
        { sessionId: "s1", snippet: "hello «world»", role: "assistant", timestamp: 2000 },
        { sessionId: "s1", snippet: "another «world» ref", role: "user", timestamp: 1000 },
      ];
      const deps = makeDeps({
        searchMessages: () => messageHits,
        getSession: (id) => (id === "s1" ? session : undefined),
      });
      const r = searchTalkSessions("world", deps);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results).toHaveLength(1);
      expect(r.results[0].sessionId).toBe("s1");
      expect(r.results[0].hits).toEqual([
        { snippet: "hello «world»", role: "assistant", ts: 2000 },
        { snippet: "another «world» ref", role: "user", ts: 1000 },
      ]);
    });

    it("ignores hits for sessions that getSession cannot resolve", () => {
      const messageHits: MessageSearchResult[] = [
        { sessionId: "ghost", snippet: "«test»", role: "user", timestamp: 1000 },
      ];
      const deps = makeDeps({
        searchMessages: () => messageHits,
        getSession: () => undefined,
      });
      const r = searchTalkSessions("test", deps);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results).toHaveLength(0);
    });
  });

  describe("de-duplication — title hit wins position", () => {
    it("title-hit session keeps its position when also a content hit", () => {
      const s1 = makeSession("s1", { title: "release pipeline" });
      const s2 = makeSession("s2");
      const messageHits: MessageSearchResult[] = [
        { sessionId: "s2", snippet: "«release» content", role: "user", timestamp: 2000 },
        { sessionId: "s1", snippet: "«release» in body", role: "assistant", timestamp: 1500 },
      ];
      const deps = makeDeps({
        searchSessions: () => [s1],
        searchMessages: () => messageHits,
        getSession: (id) => (id === "s1" ? s1 : id === "s2" ? s2 : undefined),
      });
      const r = searchTalkSessions("release", deps);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results).toHaveLength(2);
      // s1 was a title hit → first
      expect(r.results[0].sessionId).toBe("s1");
      // s1 also has the content hit attached
      expect(r.results[0].hits).toEqual([
        { snippet: "«release» in body", role: "assistant", ts: 1500 },
      ]);
      // s2 was content-only → second
      expect(r.results[1].sessionId).toBe("s2");
      expect(r.results[1].hits).toEqual([
        { snippet: "«release» content", role: "user", ts: 2000 },
      ]);
    });

    it("does not duplicate a session that appears in both sources", () => {
      const s1 = makeSession("s1");
      const messageHits: MessageSearchResult[] = [
        { sessionId: "s1", snippet: "«foo»", role: "user", timestamp: 1000 },
      ];
      const deps = makeDeps({
        searchSessions: () => [s1],
        searchMessages: () => messageHits,
        getSession: (id) => (id === "s1" ? s1 : undefined),
      });
      const r = searchTalkSessions("foo", deps);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results).toHaveLength(1);
    });
  });

  describe("caps", () => {
    it("caps hits per session at 3, keeping first 3 (newest-first from searchMessages)", () => {
      const session = makeSession("s1");
      const messageHits: MessageSearchResult[] = [
        { sessionId: "s1", snippet: "hit 4", role: "user", timestamp: 4000 },
        { sessionId: "s1", snippet: "hit 3", role: "user", timestamp: 3000 },
        { sessionId: "s1", snippet: "hit 2", role: "user", timestamp: 2000 },
        { sessionId: "s1", snippet: "hit 1", role: "user", timestamp: 1000 }, // oldest — dropped
      ];
      const deps = makeDeps({
        searchMessages: () => messageHits,
        getSession: (id) => (id === "s1" ? session : undefined),
      });
      const r = searchTalkSessions("hit", deps);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results[0].hits).toHaveLength(3);
      expect(r.results[0].hits.map((h) => h.ts)).toEqual([4000, 3000, 2000]);
    });

    it("caps overall results at 20", () => {
      const sessions = Array.from({ length: 25 }, (_, i) => makeSession(`s${i}`));
      const deps = makeDeps({
        searchSessions: () => sessions,
        getSession: (id) => sessions.find((s) => s.id === id),
      });
      const r = searchTalkSessions("session", deps);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results).toHaveLength(20);
    });

    it("caps at 20 when mixing title + content results", () => {
      const titleSessions = Array.from({ length: 12 }, (_, i) => makeSession(`ts${i}`));
      const contentSessions = Array.from({ length: 12 }, (_, i) => makeSession(`cs${i}`));
      const messageHits: MessageSearchResult[] = contentSessions.map((s, i) => ({
        sessionId: s.id,
        snippet: `«query» hit`,
        role: "user",
        timestamp: 1000 + i,
      }));
      const allSessions = [...titleSessions, ...contentSessions];
      const deps = makeDeps({
        searchSessions: () => titleSessions,
        searchMessages: () => messageHits,
        getSession: (id) => allSessions.find((s) => s.id === id),
      });
      const r = searchTalkSessions("query", deps);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results).toHaveLength(20);
    });
  });

  describe("isTalkChild", () => {
    it("is true when resolveTalkRoot returns a session for the result", () => {
      const talkRoot = makeSession("talk-root", { source: "talk" });
      const child = makeSession("child", { parentSessionId: "talk-root" });
      const deps = makeDeps({
        searchSessions: () => [child],
        getSession: (id) => (id === "child" ? child : id === "talk-root" ? talkRoot : undefined),
        resolveTalkRoot: (_id, _gs) => talkRoot,
      });
      const r = searchTalkSessions("child", deps);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results[0].isTalkChild).toBe(true);
    });

    it("is false when resolveTalkRoot returns undefined", () => {
      const session = makeSession("s1");
      const deps = makeDeps({
        searchSessions: () => [session],
        getSession: (id) => (id === "s1" ? session : undefined),
        resolveTalkRoot: () => undefined,
      });
      const r = searchTalkSessions("query", deps);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results[0].isTalkChild).toBe(false);
    });

    it("passes getSession dep through to resolveTalkRoot", () => {
      const session = makeSession("s1");
      let capturedGetSession: unknown;
      const theGetSession = (id: string) => (id === "s1" ? session : undefined);
      const deps = makeDeps({
        searchSessions: () => [session],
        getSession: theGetSession,
        resolveTalkRoot: (_id, gs) => { capturedGetSession = gs; return undefined; },
      });
      searchTalkSessions("q", deps);
      expect(capturedGetSession).toBe(theGetSession);
    });
  });

  describe("limit param", () => {
    function manySessionDeps(n: number) {
      const sessions = Array.from({ length: n }, (_, i) => makeSession(`s${i}`));
      return {
        deps: makeDeps({
          searchSessions: () => sessions,
          getSession: (id: string) => sessions.find((s) => s.id === id),
        }),
        sessions,
      };
    }

    it("honors limit=5 — returns exactly 5 results", () => {
      const { deps } = manySessionDeps(25);
      const r = searchTalkSessions("session", deps, 5);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results).toHaveLength(5);
    });

    it("clamps limit=999 to 20", () => {
      const { deps } = manySessionDeps(25);
      const r = searchTalkSessions("session", deps, 999);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results).toHaveLength(20);
    });

    it("treats limit=0 as absent — falls back to default 20", () => {
      const { deps } = manySessionDeps(25);
      const r = searchTalkSessions("session", deps, 0);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results).toHaveLength(20);
    });

    it("treats limit=NaN as absent — falls back to default 20", () => {
      const { deps } = manySessionDeps(25);
      const r = searchTalkSessions("session", deps, NaN);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results).toHaveLength(20);
    });
  });

  describe("content-only hit metadata", () => {
    it("session found only via content carries full metadata from getSession", () => {
      const session = makeSession("cx1", {
        title: "Special Title",
        employee: "support-lead",
        source: "talk",
        status: "running",
        lastActivity: "2026-06-10T09:00:00Z",
      });
      const messageHits: MessageSearchResult[] = [
        { sessionId: "cx1", snippet: "«keyword» found here", role: "assistant", timestamp: 5000 },
      ];
      const deps = makeDeps({
        searchSessions: () => [], // NOT in title hits — content-only
        searchMessages: () => messageHits,
        getSession: (id) => (id === "cx1" ? session : undefined),
        resolveTalkRoot: () => undefined,
      });
      const r = searchTalkSessions("keyword", deps);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.results).toHaveLength(1);
      expect(r.results[0]).toEqual({
        sessionId: "cx1",
        title: "Special Title",
        employee: "support-lead",
        source: "talk",
        lastActivity: "2026-06-10T09:00:00Z",
        status: "running",
        isTalkChild: false,
        hits: [{ snippet: "«keyword» found here", role: "assistant", ts: 5000 }],
      });
    });
  });

  describe("result shape", () => {
    it("includes all required fields in each result", () => {
      const session = makeSession("s1", {
        title: "My session",
        employee: "cuttlefish-dev",
        source: "web",
        status: "running",
        lastActivity: "2026-06-10T12:00:00Z",
      });
      const deps = makeDeps({
        searchSessions: () => [session],
        getSession: (id) => (id === "s1" ? session : undefined),
      });
      const r = searchTalkSessions("session", deps);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      const result = r.results[0];
      expect(result).toHaveProperty("sessionId", "s1");
      expect(result).toHaveProperty("title", "My session");
      expect(result).toHaveProperty("employee", "cuttlefish-dev");
      expect(result).toHaveProperty("source", "web");
      expect(result).toHaveProperty("lastActivity", "2026-06-10T12:00:00Z");
      expect(result).toHaveProperty("status", "running");
      expect(result).toHaveProperty("isTalkChild");
      expect(result).toHaveProperty("hits");
      expect(Array.isArray(result.hits)).toBe(true);
    });
  });
});
