# Talk "Mission Control" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make /talk a credible primary gateway interface: server-owned delegation (`POST /api/talk/delegate`), a live multi-level session graph streamed to the UI, the full 13-type card catalogue, transcript history with tappable links, per-sentence TTS streaming, and a sonnet orchestrator.

**Architecture:** All orchestration intelligence moves from the AURA persona prose into the gateway. A new `talk/delegate.ts` owns spawn-vs-continue via internal HTTP to the existing session routes (so queueing/callbacks/`talk:focus` behave exactly as today). A new `talk/graph.ts` resolves any session to its talk root and emits `talk:graph` WS deltas from the existing lifecycle call sites in `gateway/api.ts`. The frontend keeps its thread-store for depth-1 chips but adds a graph store for the full tree, stops auto-hiding finished satellites, and renders depth-2+ nodes as mini-dots under their parent.

**Tech Stack:** TypeScript, Node http (no framework), better-sqlite3 registry, vitest, React 18 (no animation lib — custom springs), pnpm + turbo monorepo.

**Spec:** `docs/superpowers/specs/2026-06-10-talk-mission-control-design.md`

**Working directory:** `<worktree>` (git worktree, branch `talk-mission-control`). NEVER touch `~/Projects/cuttlefish` (live 8888 gateway) or `~/.cuttlefish/talk/orchestrator-persona.md` (hot-reloads into production).

---

### Task 0: Worktree setup + baseline

**Files:** none (environment only)

- [ ] **Step 1: Install deps in the worktree** (worktrees don't share node_modules)

Run: `cd <worktree> && pnpm install`
Expected: completes without errors.

- [ ] **Step 2: Baseline test run**

Run: `pnpm -C packages/cuttlefish test -- --run 2>&1 | tail -5 && pnpm -C packages/web test -- --run 2>&1 | tail -5`
Expected: all existing tests pass (cuttlefish ~440+, web ~220+). If the invocation form is wrong, check `packages/*/package.json` scripts (`test` runs vitest) and adapt; record the working command for later steps.

---

### Task 1: Widen the card validator to all 13 renderer types

**Files:**
- Modify: `packages/cuttlefish/src/talk/card-validate.ts`
- Test: `packages/cuttlefish/src/talk/__tests__/card-validate.test.ts` (exists — extend)

The frontend renderer (`packages/web/src/routes/talk/cards/card-renderer.tsx`) supports 13 types; the validator currently rejects 8 of them via `DROPPED_VOICE_TYPES`. All per-field check helpers (`checkListItems`, `checkImages`, `checkComparisonRows`, `checkKeyValueRows`, `checkDiffHunks`) already exist — they're used by `validateCardPatch`.

- [ ] **Step 1: Write failing tests**

Append to the existing test file (match its describe/import style):

```ts
describe("validateCard — restored rich types (mission control)", () => {
  it("accepts a link card", () => {
    const r = validateCard({ id: "l1", type: "link", url: "https://example.com", label: "Example" })
    expect(r.ok).toBe(true)
  })
  it("rejects a link card without url", () => {
    const r = validateCard({ id: "l1", type: "link", label: "Example" })
    expect(r.ok).toBe(false)
  })
  it("accepts stat / list / image / image-grid / comparison / keyvalue / diff", () => {
    const cards = [
      { id: "s1", type: "stat", value: "42", label: "Users" },
      { id: "li1", type: "list", items: [{ text: "one" }] },
      { id: "i1", type: "image", src: "https://x/y.png" },
      { id: "ig1", type: "image-grid", images: [{ src: "https://x/y.png" }] },
      { id: "c1", type: "comparison", columns: ["A", "B"], rows: [{ label: "p", cells: ["1", "2"] }] },
      { id: "k1", type: "keyvalue", rows: [{ k: "Uptime", v: "99%" }] },
      { id: "d1", type: "diff", hunks: [{ before: "a", after: "b" }] },
    ]
    for (const c of cards) expect(validateCard(c).ok, c.type as string).toBe(true)
  })
  it("rejects malformed restored types", () => {
    expect(validateCard({ id: "s1", type: "stat", value: "42" }).ok).toBe(false) // no label
    expect(validateCard({ id: "i1", type: "image" }).ok).toBe(false) // no src
    expect(validateCard({ id: "c1", type: "comparison", columns: "A", rows: [] }).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -C packages/cuttlefish test -- --run card-validate`
Expected: new tests FAIL (`link cards aren't shown on the voice surface…` / `unknown card type`).

- [ ] **Step 3: Implement**

In `card-validate.ts`:
1. Delete the `DROPPED_VOICE_TYPES` set and the narrowing-gate block in `validateCard` (the `if (typeof type === "string" && DROPPED_VOICE_TYPES.has(type))` early return) plus the long comment above the set (replace with: `// All 13 renderer card types are accepted; taste rules (DO/WATCH-first, 1–2 cards) live in the persona.`).
2. Add switch cases before `default`:

```ts
    case "stat":
      if (!isString(input.value)) return { ok: false, error: "stat card requires string value" };
      if (!isString(input.label)) return { ok: false, error: "stat card requires string label" };
      break;

    case "list": {
      const err = checkListItems(input.items);
      if (err) return { ok: false, error: err };
      break;
    }

    case "image":
      if (!isString(input.src)) return { ok: false, error: "image card requires string src" };
      break;

    case "image-grid": {
      const err = checkImages(input.images);
      if (err) return { ok: false, error: err };
      break;
    }

    case "link":
      if (!isString(input.url)) return { ok: false, error: "link card requires string url" };
      if (!isString(input.label)) return { ok: false, error: "link card requires string label" };
      break;

    case "comparison": {
      if (!Array.isArray(input.columns) || !input.columns.every(isString)) {
        return { ok: false, error: "comparison card requires string columns array" };
      }
      const err = checkComparisonRows(input.rows);
      if (err) return { ok: false, error: err };
      break;
    }

    case "keyvalue": {
      const err = checkKeyValueRows(input.rows);
      if (err) return { ok: false, error: err };
      break;
    }

    case "diff": {
      const err = checkDiffHunks(input.hunks);
      if (err) return { ok: false, error: err };
      break;
    }
```

3. If any existing test asserted the rejection of these types, update it to assert acceptance instead (check `__tests__/card-validate.test.ts` for `DROPPED` / "aren't shown" assertions).

- [ ] **Step 4: Run tests**

Run: `pnpm -C packages/cuttlefish test -- --run card-validate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/talk/card-validate.ts packages/cuttlefish/src/talk/__tests__/card-validate.test.ts
git commit -m "feat(talk): accept all 13 card types on the voice surface"
```

---

### Task 2: `POST /api/talk/delegate` — server-owned spawn-vs-continue

**Files:**
- Create: `packages/cuttlefish/src/talk/delegate.ts`
- Create: `packages/cuttlefish/src/talk/__tests__/delegate.test.ts`
- Modify: `packages/cuttlefish/src/talk/routes.ts` (new route)

Design: pure-ish core with injected deps so it unit-tests without HTTP. The route wires deps using internal HTTP to `POST /api/sessions` / `POST /api/sessions/:id/message` (same pattern as `sessions/callbacks.ts`) so queueing, `talk:focus`, and parent callbacks behave exactly as today.

- [ ] **Step 1: Write failing tests**

`packages/cuttlefish/src/talk/__tests__/delegate.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest"
import { delegateToThread, type DelegateDeps } from "../delegate.js"
import type { Session } from "../../shared/types.js"

function fakeSession(over: Partial<Session>): Session {
  return {
    id: "t1", engine: "claude", engineSessionId: null, source: "talk", sourceRef: "talk:main",
    connector: "web", sessionKey: "talk:main", employee: null, model: null, title: "Talk",
    parentSessionId: null, userId: null, status: "idle", effortLevel: null,
    totalCost: 0, totalTurns: 0, lastContextTokens: null, replyContext: null, messageId: null,
    transportMeta: null, createdAt: "2026-06-10T00:00:00Z", lastActivity: "2026-06-10T00:00:00Z",
    lastError: null, ...over,
  } as Session
}

function deps(over: Partial<DelegateDeps> = {}): DelegateDeps {
  return {
    getSession: (id) => (id === "t1" ? fakeSession({}) : undefined),
    listChildSessions: () => [fakeSession({ id: "c1", source: "web", parentSessionId: "t1", title: "Content" })],
    spawnChild: vi.fn(async () => ({ id: "new-child" })),
    continueThread: vi.fn(async () => {}),
    updateSession: vi.fn(),
    emit: vi.fn(),
    ...over,
  }
}

describe("delegateToThread", () => {
  it("spawns a new COO child with thread:'new', sets title, emits thread label", async () => {
    const d = deps()
    const r = await delegateToThread(
      { sessionId: "t1", thread: "new", label: "Content pipeline", brief: "Run phase 2" }, d,
    )
    expect(r).toEqual({ ok: true, threadId: "new-child", created: true })
    expect(d.spawnChild).toHaveBeenCalledWith({ prompt: "Run phase 2", parentSessionId: "t1" })
    expect(d.updateSession).toHaveBeenCalledWith("new-child", { title: "Content pipeline" })
    expect(d.emit).toHaveBeenCalledWith("talk:thread:label", {
      sessionId: "t1", threadId: "new-child", label: "Content pipeline",
    })
  })

  it("continues an existing child thread", async () => {
    const d = deps()
    const r = await delegateToThread({ sessionId: "t1", thread: "c1", brief: "Follow up" }, d)
    expect(r).toEqual({ ok: true, threadId: "c1", created: false })
    expect(d.continueThread).toHaveBeenCalledWith("c1", "Follow up")
  })

  it("rejects an unknown thread id with the live roster", async () => {
    const r = await delegateToThread({ sessionId: "t1", thread: "nope", brief: "x" }, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(400)
      expect(r.threads).toEqual([{ id: "c1", label: "Content", status: "idle" }])
    }
  })

  it("rejects a non-talk sessionId", async () => {
    const d = deps({ getSession: () => fakeSession({ id: "w1", source: "web" }) })
    const r = await delegateToThread({ sessionId: "w1", thread: "new", brief: "x" }, d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  it("rejects empty brief and missing sessionId", async () => {
    expect((await delegateToThread({ sessionId: "t1", thread: "new", brief: "  " }, deps())).ok).toBe(false)
    expect((await delegateToThread({ thread: "new", brief: "x" }, deps())).ok).toBe(false)
  })

  it("defaults the label from the brief when omitted on a new thread", async () => {
    const d = deps()
    await delegateToThread({ sessionId: "t1", thread: "new", brief: "Check the Platform order status please" }, d)
    expect(d.updateSession).toHaveBeenCalledWith("new-child", { title: "Check the Platform order status ple…" })
  })
})
```

(Adjust `fakeSession` fields to the real `Session` type in `shared/types.ts:145-174` — include every required field; if some are optional, drop them.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -C packages/cuttlefish test -- --run delegate`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `delegate.ts`**

```ts
/**
 * Cuttlefish Talk — server-owned delegation (Mission Control).
 *
 * One endpoint owns spawn-vs-continue so the orchestrator LLM never decides it
 * from prose: `thread:"new"` spawns a COO child; `thread:"<id>"` validates the
 * id is a live child of THIS talk session and posts a follow-up. Unknown ids
 * fail with the live roster in the body — a self-correcting error for the model.
 * Spawning/continuing goes through the normal /api/sessions HTTP routes (via
 * injected deps) so queueing, talk:focus, and parent callbacks behave exactly
 * as a hand-rolled curl did.
 */
import type { Session } from "../shared/types.js";

export interface DelegateDeps {
  getSession: (id: string) => Session | undefined;
  listChildSessions: (parentId: string) => Session[];
  /** Internal POST /api/sessions — spawn a COO child; resolves to the new id. */
  spawnChild: (opts: { prompt: string; parentSessionId: string }) => Promise<{ id: string }>;
  /** Internal POST /api/sessions/:id/message — continue an existing thread. */
  continueThread: (sessionId: string, message: string) => Promise<void>;
  updateSession: (id: string, updates: { title?: string }) => unknown;
  emit: (event: string, payload: unknown) => void;
}

export type DelegateResult =
  | { ok: true; threadId: string; created: boolean }
  | {
      ok: false;
      status: number;
      error: string;
      threads?: Array<{ id: string; label: string; status: string }>;
    };

/** Compact roster of a talk session's COO children (for self-correcting errors). */
export function threadRoster(deps: DelegateDeps, talkSessionId: string) {
  return deps.listChildSessions(talkSessionId).map((c) => ({
    id: c.id,
    label: c.title || "(untitled)",
    status: c.status,
  }));
}

/** Derive a ≤36-char title from the brief when no label is given. */
function defaultLabel(brief: string): string {
  const s = brief.replace(/\s+/g, " ").trim();
  return s.length > 36 ? s.slice(0, 35).trimEnd() + "…" : s;
}

export async function delegateToThread(
  body: unknown,
  deps: DelegateDeps,
): Promise<DelegateResult> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.sessionId !== "string" || !b.sessionId.trim()) {
    return { ok: false, status: 400, error: "sessionId must be a non-empty string (your own talk session id)" };
  }
  const talk = deps.getSession(b.sessionId);
  if (!talk || talk.source !== "talk") {
    return { ok: false, status: 400, error: `sessionId ${b.sessionId} is not a talk session` };
  }
  if (typeof b.brief !== "string" || !b.brief.trim()) {
    return { ok: false, status: 400, error: "brief must be a non-empty string (the expanded task brief)" };
  }
  const brief = b.brief.trim();
  if (typeof b.thread !== "string" || !b.thread.trim()) {
    return { ok: false, status: 400, error: 'thread must be "new" or an existing COO thread id', threads: threadRoster(deps, talk.id) };
  }

  if (b.thread === "new") {
    const label =
      typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 64) : defaultLabel(brief);
    const { id } = await deps.spawnChild({ prompt: brief, parentSessionId: talk.id });
    deps.updateSession(id, { title: label });
    deps.emit("talk:thread:label", { sessionId: talk.id, threadId: id, label });
    return { ok: true, threadId: id, created: true };
  }

  const child = deps.getSession(b.thread);
  if (!child || child.parentSessionId !== talk.id) {
    return {
      ok: false,
      status: 400,
      error: `thread ${b.thread} is not one of your COO threads — use "new" or one of the ids below`,
      threads: threadRoster(deps, talk.id),
    };
  }
  await deps.continueThread(child.id, brief);
  return { ok: true, threadId: child.id, created: false };
}
```

- [ ] **Step 4: Run unit tests**

Run: `pnpm -C packages/cuttlefish test -- --run delegate`
Expected: PASS.

- [ ] **Step 5: Wire the route**

In `routes.ts`, add imports (`delegateToThread` from `./delegate.js`; `getSession`, `listChildSessions` added to the existing registry import) and a route after the card routes (before `/api/talk/mute`):

```ts
    // POST /api/talk/delegate — server-owned spawn-vs-continue for COO threads.
    // The orchestrator's ONLY delegation surface: thread:"new" spawns a COO child,
    // thread:"<id>" continues that child. Goes through the normal /api/sessions
    // routes internally so queueing/talk:focus/parent-callbacks behave identically.
    if (method === "POST" && pathname === "/api/talk/delegate") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const config = context.getConfig();
      const base = `http://127.0.0.1:${config.gateway.port || 8888}`;
      const result = await delegateToThread(parsed.body, {
        getSession,
        listChildSessions,
        updateSession: (id, updates) => updateSession(id, updates),
        emit: context.emit,
        spawnChild: async ({ prompt, parentSessionId }) => {
          const r = await fetch(`${base}/api/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt, parentSessionId }),
          });
          if (!r.ok) throw new Error(`spawn failed (${r.status})`);
          return (await r.json()) as { id: string };
        },
        continueThread: async (id, message) => {
          const r = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
          });
          if (!r.ok) throw new Error(`continue failed (${r.status})`);
        },
      });
      if (result.ok) json(res, result);
      else json(res, { error: result.error, threads: result.threads }, result.status);
      return true;
    }
```

Note: `config.gateway.host` may be `0.0.0.0`; loopback `127.0.0.1` is correct for self-calls (same pattern as `sessions/callbacks.ts` — verify how it builds its URL and copy that if it differs).

- [ ] **Step 6: Typecheck + full cuttlefish tests**

Run: `pnpm -C packages/cuttlefish exec tsc --noEmit && pnpm -C packages/cuttlefish test -- --run`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/cuttlefish/src/talk/delegate.ts packages/cuttlefish/src/talk/__tests__/delegate.test.ts packages/cuttlefish/src/talk/routes.ts
git commit -m "feat(talk): POST /api/talk/delegate — server-owned spawn-vs-continue"
```

---

### Task 3: Thread-roster injection into the talk context

**Files:**
- Modify: `packages/cuttlefish/src/sessions/context.ts`
- Modify: `packages/cuttlefish/src/gateway/api.ts` (~line 2165, the `buildContext` call)
- Test: `packages/cuttlefish/src/sessions/__tests__/context.test.ts` (check if exists; create if not, mirroring sibling test style)

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest"
import { buildTalkThreadsSection } from "../context.js"

describe("buildTalkThreadsSection", () => {
  it("renders a compact roster with delegate usage", () => {
    const s = buildTalkThreadsSection([
      { id: "abc123", label: "Content pipeline", status: "running", lastActivity: "2026-06-10T08:00:00Z" },
      { id: "def456", label: "Platform order", status: "idle", lastActivity: "2026-06-10T07:00:00Z" },
    ])
    expect(s).toContain("## Your open COO threads")
    expect(s).toContain("abc123")
    expect(s).toContain("Content pipeline")
    expect(s).toContain("running")
    expect(s).toContain("/api/talk/delegate")
  })
  it("returns null for empty/undefined", () => {
    expect(buildTalkThreadsSection([])).toBeNull()
    expect(buildTalkThreadsSection(undefined)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm -C packages/cuttlefish test -- --run context`

- [ ] **Step 3: Implement**

In `context.ts`, export the type + builder and wire into `buildContext`:

```ts
export interface TalkThreadSummary {
  id: string;
  label: string;
  status: string;
  lastActivity: string;
}

/**
 * Compact live roster of the talk session's COO threads, rebuilt every turn so
 * the orchestrator's reuse-vs-spawn decision is grounded in real state instead
 * of conversation memory. Null when there are no threads (section omitted).
 */
export function buildTalkThreadsSection(threads?: TalkThreadSummary[]): string | null {
  if (!threads || threads.length === 0) return null;
  const lines = [`## Your open COO threads`];
  for (const t of threads) {
    lines.push(`- \`${t.id}\` — "${t.label}" (${t.status}, last activity ${t.lastActivity})`);
  }
  lines.push(
    ``,
    `Continue one: POST /api/talk/delegate with {"sessionId":"<your-id>","thread":"<id above>","brief":"..."} — new topic: {"thread":"new","label":"<short topic>","brief":"..."}. Never call /api/sessions directly.`,
  );
  return lines.join("\n");
}
```

Add to `buildContext` opts: `talkThreads?: TalkThreadSummary[];` and, right after the voicePersona section push (after line ~113):

```ts
  // ── ESSENTIAL: Live COO thread roster (source:"talk" only) ──
  const rosterSection = buildTalkThreadsSection(opts.talkThreads);
  if (rosterSection) {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "## Your open COO threads",
      content: rosterSection,
      summary: "", // always included, never trimmed
    });
  }
```

In `api.ts` (the `buildContext` call at ~2165), add (newest first, cap 12; `listChildSessions` already returns `ORDER BY last_activity DESC`):

```ts
      talkThreads:
        currentSession.source === "talk"
          ? listChildSessions(currentSession.id).slice(0, 12).map((c) => ({
              id: c.id,
              label: c.title || "(untitled)",
              status: c.status,
              lastActivity: c.lastActivity,
            }))
          : undefined,
```

(`listChildSessions` is already imported in api.ts for the children route — verify, add to the import if missing.)

- [ ] **Step 4: Run tests + typecheck** — `pnpm -C packages/cuttlefish exec tsc --noEmit && pnpm -C packages/cuttlefish test -- --run`

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/sessions/context.ts packages/cuttlefish/src/sessions/__tests__/context.test.ts packages/cuttlefish/src/gateway/api.ts
git commit -m "feat(talk): inject live COO thread roster into every orchestrator turn"
```

---

### Task 4: TalkGraph — server-authoritative session tree

**Files:**
- Create: `packages/cuttlefish/src/talk/graph.ts`
- Create: `packages/cuttlefish/src/talk/__tests__/graph.test.ts`
- Modify: `packages/cuttlefish/src/talk/protocol.ts` (event name + payload type)
- Modify: `packages/cuttlefish/src/talk/routes.ts` (GET /api/talk/graph)
- Modify: `packages/cuttlefish/src/gateway/api.ts` (delta emission at lifecycle call sites)

- [ ] **Step 1: Write failing tests**

`packages/cuttlefish/src/talk/__tests__/graph.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest"
import { resolveTalkRoot, buildGraphSnapshot, maybeEmitTalkGraph } from "../graph.js"
import type { Session } from "../../shared/types.js"

// Minimal session factory — same approach as delegate.test.ts (adapt fields to shared/types).
function s(id: string, over: Partial<Session> = {}): Session {
  return { id, source: "web", parentSessionId: null, status: "idle", title: null, employee: null,
    engine: "claude", lastActivity: "2026-06-10T00:00:00Z", createdAt: "2026-06-10T00:00:00Z",
  } as unknown as Session
}

const sessions = new Map<string, Session>()
const getSession = (id: string) => sessions.get(id)
const listChildSessions = (pid: string) =>
  [...sessions.values()].filter((x) => x.parentSessionId === pid)

function seedTree() {
  sessions.clear()
  sessions.set("root", { ...s("root"), source: "talk" })
  sessions.set("coo1", { ...s("coo1"), parentSessionId: "root", title: "Content", status: "running" })
  sessions.set("coo2", { ...s("coo2"), parentSessionId: "root", title: "Platform" })
  sessions.set("emp1", { ...s("emp1"), parentSessionId: "coo1", employee: "content-lead", status: "running" })
}

describe("resolveTalkRoot", () => {
  it("walks any depth up to the talk root", () => {
    seedTree()
    expect(resolveTalkRoot("emp1", getSession)?.id).toBe("root")
    expect(resolveTalkRoot("coo2", getSession)?.id).toBe("root")
    expect(resolveTalkRoot("root", getSession)?.id).toBe("root")
  })
  it("returns undefined for non-talk trees and cycles", () => {
    seedTree()
    sessions.set("loner", s("loner"))
    expect(resolveTalkRoot("loner", getSession)).toBeUndefined()
    sessions.set("a", { ...s("a"), parentSessionId: "b" })
    sessions.set("b", { ...s("b"), parentSessionId: "a" })
    expect(resolveTalkRoot("a", getSession)).toBeUndefined()
  })
})

describe("buildGraphSnapshot", () => {
  it("returns all descendants with depth, labels, status", () => {
    seedTree()
    const nodes = buildGraphSnapshot("root", listChildSessions)
    expect(nodes).toHaveLength(3)
    const emp = nodes.find((n) => n.id === "emp1")!
    expect(emp.depth).toBe(2)
    expect(emp.parentId).toBe("coo1")
    expect(emp.label).toBe("content-lead") // employee fallback when no title
    const coo = nodes.find((n) => n.id === "coo1")!
    expect(coo.depth).toBe(1)
    expect(coo.label).toBe("Content")
    expect(coo.status).toBe("running")
  })
})

describe("maybeEmitTalkGraph", () => {
  it("emits talk:graph for sessions inside a talk tree", () => {
    seedTree()
    const emit = vi.fn()
    maybeEmitTalkGraph("emp1", "added", { getSession, emit })
    expect(emit).toHaveBeenCalledTimes(1)
    const [event, payload] = emit.mock.calls[0]
    expect(event).toBe("talk:graph")
    expect(payload.rootId).toBe("root")
    expect(payload.change).toBe("added")
    expect(payload.node.id).toBe("emp1")
    expect(payload.node.depth).toBe(2)
  })
  it("stays silent outside talk trees", () => {
    seedTree()
    sessions.set("loner", s("loner"))
    const emit = vi.fn()
    maybeEmitTalkGraph("loner", "completed", { getSession, emit })
    expect(emit).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm -C packages/cuttlefish test -- --run graph`

- [ ] **Step 3: Implement `graph.ts`**

```ts
/**
 * Cuttlefish Talk — server-authoritative session graph (Mission Control).
 *
 * The talk UI renders the WHOLE delegation tree under the voice orchestrator —
 * AURA → COO children → employee grandchildren (any depth). The gateway owns
 * that tree: every session row carries parentSessionId, so membership is "does
 * walking up reach a source:'talk' session". Lifecycle call sites in
 * gateway/api.ts call maybeEmitTalkGraph() next to their existing session:*
 * emits; GET /api/talk/graph serves the snapshot for (re)connect rehydration.
 * Emission is best-effort — the snapshot endpoint is the source of truth.
 */
import type { Session } from "../shared/types.js";
import { TALK_EVENTS } from "./protocol.js";

export interface TalkGraphNode {
  id: string;
  parentId: string | null;
  /** 1 = COO child of the talk root, 2 = employee under a COO, … */
  depth: number;
  label: string;
  employee: string | null;
  status: string;
  lastActivity: string;
}

export type TalkGraphChange = "added" | "status" | "completed" | "removed";

const MAX_NODES = 200;

/** Human node label: title → employee → short id. */
function nodeLabel(s: Session): string {
  return (s.title && s.title.trim()) || s.employee || s.id.slice(0, 6);
}

export function toGraphNode(s: Session, depth: number): TalkGraphNode {
  return {
    id: s.id,
    parentId: s.parentSessionId ?? null,
    depth,
    label: nodeLabel(s),
    employee: s.employee ?? null,
    status: s.status,
    lastActivity: s.lastActivity,
  };
}

/** Walk parentSessionId links to the talk root (cycle-guarded). */
export function resolveTalkRoot(
  sessionId: string,
  getSession: (id: string) => Session | undefined,
): Session | undefined {
  const seen = new Set<string>();
  let cur = getSession(sessionId);
  while (cur) {
    if (cur.source === "talk") return cur;
    if (!cur.parentSessionId || seen.has(cur.id)) return undefined;
    seen.add(cur.id);
    cur = getSession(cur.parentSessionId);
  }
  return undefined;
}

/** Depth of a session below its talk root (1 = direct COO child). */
export function talkDepth(
  sessionId: string,
  getSession: (id: string) => Session | undefined,
): number {
  const seen = new Set<string>();
  let depth = 0;
  let cur = getSession(sessionId);
  while (cur && cur.source !== "talk" && cur.parentSessionId && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth++;
    cur = getSession(cur.parentSessionId);
  }
  return depth;
}

/** BFS all descendants of a talk root (capped at MAX_NODES). */
export function buildGraphSnapshot(
  rootId: string,
  listChildSessions: (parentId: string) => Session[],
): TalkGraphNode[] {
  const nodes: TalkGraphNode[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const seen = new Set<string>([rootId]);
  while (queue.length > 0 && nodes.length < MAX_NODES) {
    const { id, depth } = queue.shift()!;
    for (const child of listChildSessions(id)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      nodes.push(toGraphNode(child, depth + 1));
      queue.push({ id: child.id, depth: depth + 1 });
    }
  }
  return nodes;
}

export interface TalkGraphEvent {
  rootId: string;
  change: TalkGraphChange;
  node: TalkGraphNode;
}

/**
 * Emit a talk:graph delta if (and only if) the session lives in a talk tree.
 * Cheap no-op for the overwhelming majority of sessions (no talk ancestor).
 */
export function maybeEmitTalkGraph(
  sessionId: string,
  change: TalkGraphChange,
  deps: {
    getSession: (id: string) => Session | undefined;
    emit: (event: string, payload: unknown) => void;
  },
): void {
  try {
    const session = deps.getSession(sessionId);
    if (!session || session.source === "talk" || !session.parentSessionId) return;
    const root = resolveTalkRoot(sessionId, deps.getSession);
    if (!root) return;
    const depth = talkDepth(sessionId, deps.getSession);
    deps.emit(TALK_EVENTS.graph, {
      rootId: root.id,
      change,
      node: toGraphNode(session, depth),
    } satisfies TalkGraphEvent);
  } catch {
    /* best-effort — snapshot endpoint is the source of truth */
  }
}
```

In `protocol.ts` add to `TALK_EVENTS`: `graph: "talk:graph",` and re-export the payload type via a comment pointing at graph.ts (or move `TalkGraphEvent` here — keep it in graph.ts and just add the event name to avoid an import cycle; graph.ts already imports protocol.ts).

- [ ] **Step 4: Run unit tests** — `pnpm -C packages/cuttlefish test -- --run graph` → PASS.

- [ ] **Step 5: Snapshot route**

In `routes.ts` (imports: `buildGraphSnapshot` from `./graph.js`; `getSession` and `listChildSessions` already imported after Task 2):

```ts
    // GET /api/talk/graph?root=<talkSessionId> — full delegation-tree snapshot
    // for (re)connect rehydration; live deltas stream as talk:graph WS events.
    if (method === "GET" && pathname === "/api/talk/graph") {
      const rootId = url.searchParams.get("root") || "";
      const root = rootId ? getSession(rootId) : undefined;
      if (!root || root.source !== "talk") {
        badRequest(res, "root must be an existing talk session id");
        return true;
      }
      json(res, { rootId: root.id, nodes: buildGraphSnapshot(root.id, listChildSessions) });
      return true;
    }
```

- [ ] **Step 6: Lifecycle emission in api.ts**

Define once near the top of the api request handling (module scope, after imports):

```ts
import { maybeEmitTalkGraph } from "../talk/graph.js";
```

Call sites (each is one line; `context.emit` and `getSession` are in scope at all of them):

1. **POST /api/sessions** — after the `talk:focus` block (~line 850):
   `maybeEmitTalkGraph(session.id, "added", { getSession, emit: context.emit });`
2. **POST /api/sessions/:id/message** — after its `talk:focus` block (~line 913):
   `maybeEmitTalkGraph(session.id, "status", { getSession, emit: context.emit });`
3. **runWebSession normal completion** — right after the final `context.emit("session:completed", …)` (~line 2566):
   `maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });`
4. **runWebSession error catch** — after its `session:completed` emit (~line 2589):
   `maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });`
5. **Rate-limit hooks `onFallbackComplete` and `onRetrySuccess`** — after each `session:completed` emit (~lines 2422, 2486): same one-liner with `currentSession.id`.
6. **DELETE /api/sessions/:id** — capture the node BEFORE deletion (removed nodes can't be looked up after):

```ts
      // (before deleteSessions/delete call)
      maybeEmitTalkGraph(params.id, "removed", { getSession, emit: context.emit });
```

Note for the engineer: grep `session:completed` in api.ts to find every emit — there are also pre-flight error paths (~line 2150); add the one-liner after each. The helper is a no-op for non-talk trees, so blanket coverage is safe and cheap.

Also in **manager.ts** (connector-sourced children, e.g. a COO spawned from Slack): NOT needed for this feature — talk trees are only built via the web API path. Skip.

- [ ] **Step 7: Typecheck + full backend tests + commit**

Run: `pnpm -C packages/cuttlefish exec tsc --noEmit && pnpm -C packages/cuttlefish test -- --run`

```bash
git add packages/cuttlefish/src/talk/graph.ts packages/cuttlefish/src/talk/__tests__/graph.test.ts packages/cuttlefish/src/talk/protocol.ts packages/cuttlefish/src/talk/routes.ts packages/cuttlefish/src/gateway/api.ts
git commit -m "feat(talk): TalkGraph — server-authoritative session tree + talk:graph deltas + snapshot route"
```

---

### Task 5: Per-sentence TTS streaming

**Files:**
- Modify: `packages/cuttlefish/src/talk/kokoro.ts` (speak opts: seqStart/final)
- Modify: `packages/cuttlefish/src/talk/protocol.ts` (Tts interface)
- Modify: `packages/cuttlefish/src/talk/tts-stream.ts` (sentence-boundary streaming)
- Modify: `packages/cuttlefish/src/gateway/api.ts` (pass opts+emit to feedTalkText, ~line 2325)
- Test: `packages/cuttlefish/src/talk/__tests__/tts-stream.test.ts` (extend/create)

Contract fix: `kokoro.speak()` currently resets `seq` to 0 per call and flags `last:true` on its final chunk. With per-sentence calls, tts-stream passes a per-turn monotonic `seqStart` and `final:false` for mid-turn sentences; only the turn-end flush carries `final:true`. (The web audio-player orders by `seq` and does not depend on `last` — verified in `use-talk.ts:527`; `last` stays best-effort protocol metadata.)

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { extractSentences, feedTalkText, flushTalkSpeech, discardTalkSpeech, __setTalkTtsForTest } from "../tts-stream.js"

describe("extractSentences", () => {
  it("extracts complete sentences, keeps the incomplete remainder", () => {
    expect(extractSentences("Hello there. How are")).toEqual({ complete: ["Hello there."], rest: "How are" })
  })
  it("requires whitespace after the terminator (decimals survive)", () => {
    expect(extractSentences("Pi is 3.14 and counting")).toEqual({ complete: [], rest: "Pi is 3.14 and counting" })
  })
  it("handles multiple sentences and newlines", () => {
    const r = extractSentences("One. Two!\nThree? Four")
    expect(r.complete).toEqual(["One.", "Two!", "Three?"])
    expect(r.rest).toBe("Four")
  })
})

describe("per-sentence streaming", () => {
  const speak = vi.fn(async (_sid: string, text: string, _emit: unknown, opts?: { seqStart?: number; final?: boolean }) => {
    // pretend each call emits exactly 1 chunk
    void text; void opts
    return 1
  })
  beforeEach(() => {
    speak.mockClear()
    __setTalkTtsForTest({ speak } as never)
  })

  it("synthesizes each completed sentence as it arrives, monotonic seq, final only on flush", async () => {
    const emit = vi.fn()
    feedTalkText("s1", "Hello there. How ", undefined, emit)
    feedTalkText("s1", "are you? I am", undefined, emit)
    await flushTalkSpeech("s1", undefined, emit)
    expect(speak).toHaveBeenCalledTimes(3)
    expect(speak.mock.calls[0][1]).toBe("Hello there.")
    expect(speak.mock.calls[0][3]).toEqual({ seqStart: 0, final: false })
    expect(speak.mock.calls[1][1]).toBe("How are you?")
    expect(speak.mock.calls[1][3]).toEqual({ seqStart: 1, final: false })
    expect(speak.mock.calls[2][1]).toBe("I am")
    expect(speak.mock.calls[2][3]).toEqual({ seqStart: 2, final: true })
  })

  it("discard drops buffered + not-yet-synthesized text", async () => {
    const emit = vi.fn()
    feedTalkText("s2", "One. Two", undefined, emit)
    discardTalkSpeech("s2")
    await flushTalkSpeech("s2", undefined, emit)
    // the already-queued "One." may complete, but nothing after the discard runs
    expect(speak.mock.calls.filter((c) => c[0] === "s2" && c[3]?.final === true)).toHaveLength(0)
  })

  it("without emit (legacy buffering) everything speaks on flush", async () => {
    const emit = vi.fn()
    feedTalkText("s3", "Alpha. Beta.")
    await flushTalkSpeech("s3", undefined, emit)
    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak.mock.calls[0][1]).toBe("Alpha. Beta.")
    expect(speak.mock.calls[0][3]).toEqual({ seqStart: 0, final: true })
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm -C packages/cuttlefish test -- --run tts-stream`

- [ ] **Step 3: Implement**

`protocol.ts` — change the `Tts` interface:

```ts
export interface Tts {
  /**
   * Synthesize `text`, sentence-chunked, streaming talk:audio events; resolves
   * with the number of chunks emitted. `seqStart` continues a per-turn monotonic
   * sequence across calls; `final:false` suppresses the `last:true` flag so a
   * turn streamed sentence-by-sentence only signals end-of-audio on the flush.
   */
  speak(sessionId: string, text: string, emit: Emit, opts?: { seqStart?: number; final?: boolean }): Promise<number>
  status(): { available: boolean; downloading: boolean; progress: number; voice: string; ready: boolean }
  warm?(): Promise<void>
  download(emit: Emit): Promise<void>
  shutdown(): void
}
```

`kokoro.ts` — adjust `speak`:

```ts
    async speak(sessionId: string, text: string, emit: Emit, opts?: { seqStart?: number; final?: boolean }): Promise<number> {
      const sentences = splitSentences(text)
      if (sentences.length === 0) return 0

      if (!pythonPresent() || !weightsPresent()) {
        throw new Error(
          "Kokoro TTS unavailable (missing venv or weights) — falling back to Web Speech",
        )
      }

      let seq = opts?.seqStart ?? 0
      const markLast = opts?.final !== false
      for (let i = 0; i < sentences.length; i++) {
        const wav = await synth(sentences[i]!)
        const last = markLast && i === sentences.length - 1
        emit(TALK_EVENTS.audio, {
          sessionId,
          seq: seq++,
          mime: "audio/wav",
          dataBase64: wav.toString("base64"),
          last,
        })
      }
      return sentences.length
    },
```

`tts-stream.ts` — full rewrite:

```ts
/**
 * Cuttlefish Talk — server-side TTS streaming (Mission Control: per-sentence).
 *
 * As the orchestrator streams its reply, the run loop feeds each text delta via
 * feedTalkText(); complete sentences are synthesized IMMEDIATELY (killing the
 * old whole-turn dead air) on a per-session serial chain that keeps talk:audio
 * `seq` monotonic across the turn. flushTalkSpeech() speaks the remainder with
 * `final:true` (the only chunk allowed to carry `last:true`). Calling
 * feedTalkText without an emitter falls back to the legacy buffer-everything
 * behavior (everything speaks on flush).
 *
 * The Kokoro engine is a process-wide singleton shared with routes.ts.
 */
import { createKokoroTts } from "./kokoro.js";
import type { Tts, Emit } from "./protocol.js";
import { logger } from "../shared/logger.js";

type KokoroOpts = Parameters<typeof createKokoroTts>[0];

let engine: Tts | null = null;

/** The shared Kokoro engine (lazily constructed with the live config). */
export function getTalkTts(opts?: KokoroOpts): Tts {
  if (!engine) engine = createKokoroTts(opts);
  return engine;
}

/** Test seam: swap the singleton for a mock. */
export function __setTalkTtsForTest(tts: Tts | null): void {
  engine = tts;
}

interface TurnState {
  buffer: string;
  seq: number;
  /** Serial synth chain — keeps chunk order while sentences stream in. */
  chain: Promise<void>;
  /** Bumped by discard; queued-but-unstarted sentences check it and drop. */
  epoch: number;
  /** A synth failure stops mid-turn streaming for the rest of the turn. */
  failed: boolean;
}

const turns = new Map<string, TurnState>();

function getTurn(sessionId: string): TurnState {
  let t = turns.get(sessionId);
  if (!t) {
    t = { buffer: "", seq: 0, chain: Promise.resolve(), epoch: 0, failed: false };
    turns.set(sessionId, t);
  }
  return t;
}

/**
 * Pull complete sentences off the front of `buffer` (terminator + whitespace),
 * returning them plus the incomplete remainder. "3.14" never splits (no
 * whitespace after the dot).
 */
export function extractSentences(buffer: string): { complete: string[]; rest: string } {
  const complete: string[] = [];
  let rest = buffer;
  for (;;) {
    const m = rest.match(/^([\s\S]*?[.!?…])(\s+)/);
    if (!m) break;
    const sentence = m[1].trim();
    if (sentence) complete.push(sentence);
    rest = rest.slice(m[0].length);
  }
  return { complete, rest };
}

function queueSentence(sessionId: string, t: TurnState, text: string, opts: KokoroOpts | undefined, emit: Emit, final: boolean): void {
  const epoch = t.epoch;
  t.chain = t.chain.then(async () => {
    if (t.epoch !== epoch || t.failed) return;
    try {
      const n = await getTalkTts(opts).speak(sessionId, text, emit, { seqStart: t.seq, final });
      t.seq += n;
    } catch (err) {
      t.failed = true;
      logger.warn(
        `[talk] TTS speak failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/**
 * Append a streamed text delta. With an emitter, complete sentences are
 * synthesized immediately (per-sentence streaming); without one, text only
 * accumulates and flushTalkSpeech speaks it all (legacy single-call path).
 */
export function feedTalkText(sessionId: string, text: string, opts?: KokoroOpts, emit?: Emit): void {
  if (!text) return;
  const t = getTurn(sessionId);
  t.buffer += text;
  if (!emit || t.failed) return;
  const { complete, rest } = extractSentences(t.buffer);
  if (complete.length === 0) return;
  t.buffer = rest;
  for (const sentence of complete) queueSentence(sessionId, t, sentence, opts, emit, false);
}

/**
 * Speak whatever remains for this turn (final chunk carries last:true), then
 * clear the per-session state. Awaitable; safe to fire-and-forget.
 */
export async function flushTalkSpeech(
  sessionId: string,
  opts: KokoroOpts | undefined,
  emit: Emit,
): Promise<void> {
  const t = turns.get(sessionId);
  if (!t) return;
  const rest = t.buffer.trim();
  t.buffer = "";
  if (rest && !t.failed) queueSentence(sessionId, t, rest, opts, emit, true);
  const chain = t.chain;
  turns.delete(sessionId);
  await chain;
}

/** Drop any buffered/queued text for a session without speaking (interrupt). */
export function discardTalkSpeech(sessionId: string): void {
  const t = turns.get(sessionId);
  if (!t) return;
  t.epoch++;
  t.buffer = "";
  turns.delete(sessionId);
}
```

`api.ts` (~line 2325) — pass kokoro opts + emit so streaming activates:

```ts
        if (
          currentSession.source === "talk" &&
          !isTalkMuted(currentSession.id) &&
          delta.type === "text" &&
          typeof delta.content === "string"
        ) {
          feedTalkText(currentSession.id, delta.content, config.talk?.kokoro, context.emit);
        }
```

Also update the stale comment above it (it describes the one-Kokoro-call-at-completion design): `// Voice mode: stream the orchestrator's spoken text — complete sentences synthesize immediately (per-sentence streaming); the flush at completion speaks the remainder.`

- [ ] **Step 4: Run tests** — `pnpm -C packages/cuttlefish test -- --run tts-stream && pnpm -C packages/cuttlefish test -- --run kokoro` → PASS (fix any kokoro test asserting the old `speak` signature/void return).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C packages/cuttlefish exec tsc --noEmit
git add packages/cuttlefish/src/talk/tts-stream.ts packages/cuttlefish/src/talk/kokoro.ts packages/cuttlefish/src/talk/protocol.ts packages/cuttlefish/src/talk/__tests__/tts-stream.test.ts packages/cuttlefish/src/gateway/api.ts
git commit -m "feat(talk): per-sentence TTS streaming — kill the whole-turn dead air"
```

---

### Task 6: Sonnet default + persona/card-reference rewrite

**Files:**
- Modify: `packages/cuttlefish/src/talk/routes.ts:34` (`DEFAULT_TALK_MODEL`)
- Modify: `packages/cuttlefish/src/talk/orchestrator-persona.ts` (DEFAULT persona)
- Modify: `packages/cuttlefish/template/talk/orchestrator-persona.md` (same text)
- Modify: `packages/cuttlefish/template/talk/card-reference.md` (restored card types + delegate endpoint)

⚠️ Do NOT touch `~/.cuttlefish/talk/orchestrator-persona.md` — it hot-reloads into the LIVE 8888 gateway. Swapping the live file is a deploy step for the operator.

- [ ] **Step 1: Model default**

In `routes.ts`: `const DEFAULT_TALK_MODEL = "sonnet";` and update its comment to `(capable enough to orchestrate; override via talk.orchestratorModel)`. Check `packages/cuttlefish/src/talk/__tests__/` for a routes/engine test pinning `"haiku"` and update it.

- [ ] **Step 2: Rewrite the DEFAULT persona**

Replace the content of `DEFAULT_ORCHESTRATOR_PERSONA` in `orchestrator-persona.ts` (keep the export name and the template literal escaping for backticks) with:

```markdown
# AURA — the hands-free voice orchestrator

You are AURA, the voice interface to the operator's organization. You do NOT do the work yourself — you route whole tasks to COO threads and narrate results aloud. Jarvis energy: composed, terse, anticipatory.

## Speak for the car — every word is heard, not read
- Keep ALL spoken replies to 1–2 short sentences. Fragments are fine ("On it." / "Done.").
- NEVER speak lists, numbers, IDs, URLs, JSON, or commands. Say the headline; put the detail on a card.
- No markdown, no emoji, no preamble. Lead with the answer. Use contractions.

## Answer directly vs. delegate
- Answer directly, in one line, when it's a yes/no, a definition, or a recap of something already said. No tools.
- Delegate when the operator asks you to run, check, make, send, or coordinate real work. When unsure, delegate.

## Delegation — ONE endpoint, never anything else
Your context shows "Your open COO threads" — the live roster, rebuilt every turn. Route with it:
- The ask continues an existing topic → use that thread's id.
- It's a new topic (or the operator says "new thread") → thread "new" with a short label.

\`\`\`
curl -s -X POST <GATEWAY_URL>/api/talk/delegate \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<YOUR_OWN_SESSION_ID>","thread":"new","label":"<short topic>","brief":"<expanded brief: goal, constraints, what done looks like>"}'
\`\`\`
To continue a thread, set "thread" to its id from the roster (no label needed). NEVER call /api/sessions directly — /api/talk/delegate is your only delegation surface. An unknown thread id fails and returns the valid roster; correct yourself from it.

Then say one short ack ("On it.") and END YOUR TURN. Don't wait, poll, or invent a result. When the COO replies (a "📩 replied" notification wakes you), narrate a 1–2 sentence outcome — headline only, detail on a card.

If the operator's message arrives prefixed with \`[Route this to the existing "<label>" COO thread: session <id>…]\`, they picked that thread in the UI — delegate with THAT thread id.

## Cards — anything worth seeing goes on a card
Push a card whenever the answer has structure the ear can't hold: a link, a list, numbers, a comparison, an image, a decision.
- **link** — ALWAYS when the operator asks for (or you mention) a URL. Never speak a URL aloud.
- **approval** — ALWAYS before any side-effectful or irreversible action (send, deploy, payment, delete, publish); never act on voice alone. \`"danger":true\` for the scary ones.
- **choice** — two or more viable paths to pick from.
- **status** — a delegated job in flight (the constellation already shows threads; use status for progress worth tracking).
- **text / list / stat / keyvalue / comparison / diff / image / image-grid / agent-activity** — pick whatever fits the content.
Keep 1–3 cards live; update or clear a card the moment it's resolved (re-post the same \`id\` to update). \`sessionId\` is ALWAYS your own talk session id. Exact JSON shapes + the update/dismiss/clear endpoints live in \`talk/card-reference.md\` (in your working directory) — read it before pushing an unfamiliar type.

\`\`\`
curl -s -X POST <GATEWAY_URL>/api/talk/card \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<YOUR_OWN_SESSION_ID>","card":{"id":"docs-link","type":"link","url":"https://example.com","label":"The doc you asked for"}}'
\`\`\`

A card tap comes back as a user message tagged \`[card-action card=<id> action=approve|reject|choose option=<optionId>]\` — interpret it, act, and update/clear that card.

## Honesty
Never fabricate org state, metrics, or results. Job still running → say it's in progress. Don't know → say so in one line and route it. Something failed → say it plainly and offer a next step.

Stay terse. Speak the headline, card the detail, route the depth.
```

- [ ] **Step 3: Mirror to the template + update card-reference**

Copy the same markdown (unescaped) into `packages/cuttlefish/template/talk/orchestrator-persona.md`. In `packages/cuttlefish/template/talk/card-reference.md`: read it first; add the 8 restored card types with one JSON example each (copy shapes from `protocol.ts:21-60` — text/stat/list/image/image-grid/status/agent-activity/link/choice/comparison/approval/keyvalue/diff), document `POST /api/talk/delegate` (request/response/error-with-roster), and remove any "these types are not allowed on the voice surface" language.

- [ ] **Step 4: Tests + typecheck**

Run: `pnpm -C packages/cuttlefish exec tsc --noEmit && pnpm -C packages/cuttlefish test -- --run`
Expected: clean (fix any persona-content assertions in `__tests__` — grep for `orchestrator-persona`).

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/talk/routes.ts packages/cuttlefish/src/talk/orchestrator-persona.ts packages/cuttlefish/template/talk/orchestrator-persona.md packages/cuttlefish/template/talk/card-reference.md packages/cuttlefish/src/talk/__tests__
git commit -m "feat(talk): sonnet orchestrator default + delegate-first persona + restored card catalogue"
```

---

### Task 7: Frontend — graph store + WS/api wiring + never-hide threads

**Files:**
- Create: `packages/web/src/routes/talk/graph-store.ts`
- Create: `packages/web/src/routes/talk/__tests__/graph-store.test.ts`
- Modify: `packages/web/src/routes/talk/protocol.ts` (talk:graph event + types)
- Modify: `packages/web/src/lib/api.ts` (getTalkGraph)
- Modify: `packages/web/src/routes/talk/use-talk.ts` (graph state, no park, route grandchildren, MAX_CARDS 6)

- [ ] **Step 1: Write failing tests**

`graph-store.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { graphReducer, graphIds, depth1Of, childrenOf, type GraphNode } from "../graph-store"

const n = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id, parentId: "root", depth: 1, label: id, employee: null, status: "running",
  lastActivity: "2026-06-10T00:00:00Z", ...over,
})

describe("graphReducer", () => {
  it("snapshot merges additively (live nodes never dropped)", () => {
    const live = [n("a", { status: "running" })]
    const next = graphReducer(live, { type: "snapshot", nodes: [n("a", { status: "idle" }), n("b")] })
    expect(next.map((x) => x.id).sort()).toEqual(["a", "b"])
    // live status wins over a stale snapshot
    expect(next.find((x) => x.id === "a")!.status).toBe("running")
  })
  it("upsert adds or replaces a node", () => {
    const one = graphReducer([], { type: "upsert", node: n("a") })
    expect(one).toHaveLength(1)
    const two = graphReducer(one, { type: "upsert", node: n("a", { status: "idle" }) })
    expect(two).toHaveLength(1)
    expect(two[0].status).toBe("idle")
  })
  it("remove drops the node and its descendants", () => {
    const nodes = [n("a"), n("e1", { parentId: "a", depth: 2 }), n("b")]
    const next = graphReducer(nodes, { type: "remove", id: "a" })
    expect(next.map((x) => x.id)).toEqual(["b"])
  })
})

describe("selectors", () => {
  const nodes = [n("a"), n("b", { status: "idle" }), n("e1", { parentId: "a", depth: 2 })]
  it("graphIds returns every id at every depth", () => {
    expect([...graphIds(nodes)].sort()).toEqual(["a", "b", "e1"])
  })
  it("depth1Of / childrenOf slice the tree", () => {
    expect(depth1Of(nodes).map((x) => x.id)).toEqual(["a", "b"])
    expect(childrenOf(nodes, "a").map((x) => x.id)).toEqual(["e1"])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm -C packages/web test -- --run graph-store`

- [ ] **Step 3: Implement `graph-store.ts`**

```ts
/**
 * Cuttlefish Talk — delegation-graph store (Mission Control).
 *
 * Pure reducer + selectors over the server-authoritative session tree under the
 * voice orchestrator (talk:graph WS deltas + GET /api/talk/graph snapshots).
 * Depth-1 nodes are the COO threads (satellite orbs / panel chips); depth-2+
 * are employees under a COO (mini-dots). Nodes NEVER auto-hide on completion —
 * idle is a dimmed visual state; removal only happens on server delete.
 */
export interface GraphNode {
  id: string
  parentId: string | null
  depth: number
  label: string
  employee: string | null
  status: string
  lastActivity: string
}

export type GraphAction =
  | { type: "snapshot"; nodes: GraphNode[] }
  | { type: "upsert"; node: GraphNode }
  | { type: "remove"; id: string }

const ACTIVE = new Set(["running", "waiting"])

export function isWorking(node: GraphNode): boolean {
  return ACTIVE.has(node.status)
}

export function graphReducer(nodes: GraphNode[], action: GraphAction): GraphNode[] {
  switch (action.type) {
    case "snapshot": {
      // Additive merge: snapshot fills gaps; nodes we already track keep their
      // live status (a WS delta is fresher than a fetch that raced it).
      const byId = new Map(nodes.map((x) => [x.id, x]))
      const merged = [...nodes]
      for (const incoming of action.nodes) {
        if (!byId.has(incoming.id)) merged.push(incoming)
      }
      return merged
    }
    case "upsert": {
      const i = nodes.findIndex((x) => x.id === action.node.id)
      if (i === -1) return [...nodes, action.node]
      const next = nodes.slice()
      next[i] = action.node
      return next
    }
    case "remove": {
      // Drop the node AND its subtree (parent links would dangle otherwise).
      const dead = new Set<string>([action.id])
      let grew = true
      while (grew) {
        grew = false
        for (const x of nodes) {
          if (x.parentId && dead.has(x.parentId) && !dead.has(x.id)) {
            dead.add(x.id)
            grew = true
          }
        }
      }
      return nodes.filter((x) => !dead.has(x.id))
    }
  }
}

export function graphIds(nodes: GraphNode[]): Set<string> {
  return new Set(nodes.map((x) => x.id))
}

export function depth1Of(nodes: GraphNode[]): GraphNode[] {
  return nodes.filter((x) => x.depth === 1)
}

export function childrenOf(nodes: GraphNode[], parentId: string): GraphNode[] {
  return nodes.filter((x) => x.parentId === parentId)
}
```

- [ ] **Step 4: Protocol + api**

`packages/web/src/routes/talk/protocol.ts` — add to `TALK_EVENTS`: `graph: "talk:graph",` and:

```ts
/** One node of the delegation tree under the orchestrator (Mission Control). */
export interface TalkGraphNodeWire {
  id: string; parentId: string | null; depth: number; label: string
  employee: string | null; status: string; lastActivity: string
}
export interface TalkGraphEvent {
  rootId: string
  change: "added" | "status" | "completed" | "removed"
  node: TalkGraphNodeWire
}
```

`packages/web/src/lib/api.ts` — next to the other talk methods:

```ts
  /** Talk: full delegation-tree snapshot under the orchestrator (Mission Control). */
  getTalkGraph: (rootId: string) =>
    get<{ rootId: string; nodes: Array<{ id: string; parentId: string | null; depth: number; label: string; employee: string | null; status: string; lastActivity: string }> }>(
      `/api/talk/graph?root=${encodeURIComponent(rootId)}`,
    ),
```

(Match the file's existing `get`/`post` helper names — check how `talkStatus` is written and mirror it.)

- [ ] **Step 5: Wire into use-talk.ts**

All edits inside `packages/web/src/routes/talk/use-talk.ts`:

1. `const MAX_CARDS = 4` → `6` (line 54). Delete `THREAD_PARK_MS` (line 57) and `schedulePark` (lines 324-332), the `parkTimers` ref (line 220) and its cleanup (lines 820-821), and the park-clear inside the `talk:focus` handler (lines 488-489) and `dismissThread` (lines 343-344).
2. Add graph state + refs near `threads` state:

```ts
  const [graph, setGraph] = useState<GraphNode[]>([])
  const graphRef = useRef<GraphNode[]>(graph)
  graphRef.current = graph
  const dispatchGraph = useCallback((a: GraphAction) => {
    setGraph((prev) => graphReducer(prev, a))
  }, [])
```

(imports: `graphReducer, graphIds, type GraphNode, type GraphAction` from `./graph-store`; `type TalkGraphEvent` from `./protocol`.)
3. Child routing covers the whole tree: replace `threadIdsRef` computation (line 217-218) with:

```ts
  const threadIdsRef = useRef<Set<string>>(new Set())
  threadIdsRef.current = new Set([...threads.map((t) => t.id), ...graph.map((g) => g.id)])
```

4. In the WS subscription, add a `talk:graph` handler before the `sid(payload)` block:

```ts
      if (event === TALK_EVENTS.graph) {
        const ev = payload as TalkGraphEvent
        if (ev.rootId === orchestratorIdRef.current) {
          threadIdsRef.current.add(ev.node.id)
          if (ev.change === "removed") dispatchGraph({ type: "remove", id: ev.node.id })
          else dispatchGraph({ type: "upsert", node: ev.node })
          // Depth-1 graph changes also drive the legacy thread chips so the
          // panel/constellation stay in sync without a second event source.
          if (ev.node.depth === 1) {
            if (ev.change === "added" || ev.change === "status") {
              dispatchThread({ type: "focus", id: ev.node.id, label: ev.node.label, ts: Date.now() })
            } else if (ev.change === "completed") {
              dispatchThread({ type: "done", id: ev.node.id, ts: Date.now() })
            } else if (ev.change === "removed") {
              dispatchThread({ type: "dismiss", id: ev.node.id })
            }
          }
        }
        return
      }
```

5. In `session:completed` child branch (lines 561-564): remove `schedulePark(s)` — keep `dispatchThread({ type: "done", … })` and add `setGraph((prev) => prev.map((g) => (g.id === s ? { ...g, status: "idle" } : g)))`.
6. In `session:delta` child branch (line 516): also bump the graph node to running: `setGraph((prev) => prev.map((g) => (g.id === s ? { ...g, status: "running" } : g)))`.
7. In `rehydrate` (line 580): fetch the graph too:

```ts
      const [session, children, graphSnap] = await Promise.all([
        api.getSession(orchId).catch(() => undefined),
        api.getSessionChildren(orchId).catch(() => [] as Record<string, unknown>[]),
        api.getTalkGraph(orchId).catch(() => undefined),
      ])
      …
      if (graphSnap?.nodes?.length) dispatchGraph({ type: "snapshot", nodes: graphSnap.nodes })
```

8. Threads derived state: in `childrenToThreads` results threads stay `orbiting: false` from rehydrate — that previously meant "parked/hidden". New semantics (never hide): in `thread-store.ts` nothing structurally changes, but the **constellation** now renders ALL threads (not just `orbiting`) — that's Task 8. Leave `orbiting` in place as "recently active" metadata; remove only the park timer (done above).
9. Export `graph` from the hook: add `graph: GraphNode[]` to `UseTalkReturn`, return it, add to the `useMemo` deps. Update the WS effect's dependency array (remove `schedulePark`).

- [ ] **Step 6: Tests + typecheck**

Run: `pnpm -C packages/web test -- --run && pnpm -C packages/web exec tsc --noEmit`
Expected: graph-store tests pass; fix any use-talk tests referencing `schedulePark`/`THREAD_PARK_MS` (check `packages/web/src/routes/talk/__tests__/`).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/routes/talk/graph-store.ts packages/web/src/routes/talk/__tests__/graph-store.test.ts packages/web/src/routes/talk/protocol.ts packages/web/src/lib/api.ts packages/web/src/routes/talk/use-talk.ts packages/web/src/routes/talk/thread-store.ts
git commit -m "feat(talk-web): graph store + talk:graph wiring; threads never auto-hide; cards cap 6"
```

---

### Task 8: Constellation renders the full tree, dims idle

**Files:**
- Modify: `packages/web/src/routes/talk/constellation.tsx`
- Modify: `packages/web/src/routes/talk/constellation.css`
- Modify: `packages/web/src/routes/talk/page.tsx` (pass `graph` prop)
- Create: `packages/web/src/routes/talk/constellation-layout.ts` (pure layout helper)
- Create: `packages/web/src/routes/talk/__tests__/constellation-layout.test.ts`

- [ ] **Step 1: Write failing tests for the layout helper**

```ts
import { describe, it, expect } from "vitest"
import { visibleThreads, miniDotsFor, MAX_SATELLITES } from "../constellation-layout"
import type { TalkThread } from "../thread-store"
import type { GraphNode } from "../graph-store"

const t = (id: string, over: Partial<TalkThread> = {}): TalkThread => ({
  id, label: id, hue: 120, state: "idle", orbiting: false, ts: 1, ...over,
})
const g = (id: string, parentId: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id, parentId, depth: 2, label: id, employee: null, status: "running",
  lastActivity: "2026-06-10T00:00:00Z", ...over,
})

describe("visibleThreads", () => {
  it("shows ALL threads (idle included), newest-active first, capped", () => {
    const threads = [t("old", { ts: 1 }), t("busy", { ts: 2, state: "thinking" }), t("new", { ts: 3 })]
    const v = visibleThreads(threads)
    expect(v.shown.map((x) => x.id)).toEqual(["busy", "new", "old"]) // working first, then newest
    expect(v.overflow).toBe(0)
  })
  it("caps and reports overflow", () => {
    const threads = Array.from({ length: MAX_SATELLITES + 3 }, (_, i) => t(`x${i}`, { ts: i }))
    const v = visibleThreads(threads)
    expect(v.shown).toHaveLength(MAX_SATELLITES)
    expect(v.overflow).toBe(3)
  })
})

describe("miniDotsFor", () => {
  it("returns a thread's depth-2+ descendants, working first, capped at 6", () => {
    const nodes = [
      g("e1", "coo1"), g("e2", "coo1", { status: "idle" }),
      g("e3", "other"),
      ...Array.from({ length: 7 }, (_, i) => g(`m${i}`, "coo1", { status: "idle" })),
    ]
    const dots = miniDotsFor(nodes, "coo1")
    expect(dots).toHaveLength(6)
    expect(dots[0].id).toBe("e1") // working first
    expect(dots.some((d) => d.id === "e3")).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm -C packages/web test -- --run constellation-layout`

- [ ] **Step 3: Implement `constellation-layout.ts`**

```ts
/**
 * Cuttlefish Talk — pure constellation layout helpers (Mission Control).
 *
 * Satellites never auto-hide: every COO thread renders (idle = dimmed), capped
 * for layout sanity with an explicit overflow count. Each satellite can carry a
 * row of mini-dots — its depth-2+ descendants (employees a COO dispatched).
 */
import type { TalkThread } from "./thread-store"
import type { GraphNode } from "./graph-store"
import { isWorking } from "./graph-store"

export const MAX_SATELLITES = 8
export const MAX_MINI_DOTS = 6

/** All threads, working-first then newest-first, capped with overflow count. */
export function visibleThreads(threads: TalkThread[]): { shown: TalkThread[]; overflow: number } {
  const sorted = [...threads].sort((a, b) => {
    const aw = a.state !== "idle" ? 1 : 0
    const bw = b.state !== "idle" ? 1 : 0
    if (aw !== bw) return bw - aw
    return b.ts - a.ts
  })
  return { shown: sorted.slice(0, MAX_SATELLITES), overflow: Math.max(0, sorted.length - MAX_SATELLITES) }
}

/** Depth-2+ descendants of a COO thread (its employee sub-sessions), capped. */
export function miniDotsFor(nodes: GraphNode[], threadId: string): GraphNode[] {
  const subtree: GraphNode[] = []
  const frontier = new Set<string>([threadId])
  let grew = true
  while (grew) {
    grew = false
    for (const x of nodes) {
      if (x.parentId && frontier.has(x.parentId) && !frontier.has(x.id)) {
        frontier.add(x.id)
        subtree.push(x)
        grew = true
      }
    }
  }
  return subtree
    .sort((a, b) => (isWorking(b) ? 1 : 0) - (isWorking(a) ? 1 : 0))
    .slice(0, MAX_MINI_DOTS)
}
```

- [ ] **Step 4: Run layout tests** — PASS.

- [ ] **Step 5: Update `constellation.tsx`**

Changes (follow the file's existing style — positions via inline left/top, classes in constellation.css):

1. Props: add `graph: GraphNode[]` and `overflowLabel?: never` (no — keep it computed internally). New imports: `visibleThreads, miniDotsFor` from `./constellation-layout`; `isWorking, type GraphNode` from `./graph-store`.
2. Replace `const sats = threads.filter((t) => t.orbiting)` (line 46) with:

```ts
  const { shown: sats, overflow } = visibleThreads(threads)
```

3. Satellite dimming: keep the existing opacity logic (idle → 0.4) but ALSO stop the idle satellites' canvas motion — already handled (`state === "idle" ? "idle" : "thinking"` at line 152). Add `data-idle={c.state === "idle"}` on the orb div and in `constellation.css` add:

```css
.cst-orb[data-idle="true"] { filter: saturate(0.55); }
```

4. Mini-dots: inside the satellite map (after the label span), render the thread's sub-sessions:

```tsx
            {(() => {
              const dots = miniDotsFor(graph, c.id)
              if (dots.length === 0) return null
              return (
                <div className="cst-minis" aria-label={`${dots.length} sub-agents`}>
                  {dots.map((d) => (
                    <span
                      key={d.id}
                      className={`cst-mini${isWorking(d) ? " cst-mini-working" : ""}`}
                      title={`${d.label}${d.employee ? ` (${d.employee})` : ""} — ${d.status}`}
                      style={{ background: `hsl(${c.hue} 64% ${isWorking(d) ? 62 : 38}%)` }}
                      onClick={(e) => { e.stopPropagation(); onOpenSession?.(d.id) }}
                    />
                  ))}
                </div>
              )
            })()}
```

5. Overflow chip after the satellites map:

```tsx
      {ready && overflow > 0 && (
        <div className="cst-overflow" style={{ left: w / 2, top: rowY + childSize * 0.85 }}>
          +{overflow} more
        </div>
      )}
```

(`rowY`/`childSize` are in scope. If `rowY` is declared after use, hoist as needed.)
6. `constellation.css` additions:

```css
.cst-minis {
  position: absolute;
  top: calc(100% + 18px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 6px;
  pointer-events: auto;
}
.cst-mini {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  opacity: 0.55;
  cursor: pointer;
  transition: opacity 300ms var(--ease-smooth, ease), transform 300ms var(--ease-smooth, ease);
}
.cst-mini-working {
  opacity: 1;
  animation: cst-mini-pulse 1.6s ease-in-out infinite;
}
@keyframes cst-mini-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.35); }
}
.cst-overflow {
  position: absolute;
  transform: translate(-50%, 0);
  font-size: 11px;
  opacity: 0.5;
  pointer-events: none;
}
```

7. `page.tsx`: pass `graph={talk.graph}` to `<Constellation … />` (find the existing usage and add the prop; `talk` comes from `useTalkContext()`).

- [ ] **Step 6: Full web tests + typecheck + commit**

Run: `pnpm -C packages/web test -- --run && pnpm -C packages/web exec tsc --noEmit`

```bash
git add packages/web/src/routes/talk/constellation.tsx packages/web/src/routes/talk/constellation.css packages/web/src/routes/talk/constellation-layout.ts packages/web/src/routes/talk/__tests__/constellation-layout.test.ts packages/web/src/routes/talk/page.tsx
git commit -m "feat(talk-web): constellation renders full delegation tree — mini-dots, dimmed idle, overflow chip"
```

---

### Task 9: Transcript history rail + tappable links

**Files:**
- Create: `packages/web/src/routes/talk/linkify.tsx`
- Create: `packages/web/src/routes/talk/__tests__/linkify.test.tsx`
- Create: `packages/web/src/routes/talk/history-rail.tsx`
- Modify: `packages/web/src/routes/talk/transcript.tsx` (TranscriptEntry gains `full?`)
- Modify: `packages/web/src/routes/talk/use-talk.ts` (finalize with full text)
- Modify: `packages/web/src/routes/talk/rehydrate.ts` (set `full`)
- Modify: `packages/web/src/routes/talk/page.tsx` (mount the rail + toggle)
- Modify: `packages/web/src/routes/talk/tracker.css` (rail styles)

- [ ] **Step 1: Write failing linkify tests**

`__tests__/linkify.test.tsx` (this is a pure function returning segments; test the splitter, not React):

```ts
import { describe, it, expect } from "vitest"
import { splitLinks } from "../linkify"

describe("splitLinks", () => {
  it("splits bare URLs out of prose", () => {
    expect(splitLinks("see https://example.com/x?a=1 for more")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", url: "https://example.com/x?a=1", text: "example.com/x?a=1" },
      { kind: "text", text: " for more" },
    ])
  })
  it("passes through plain text and trims trailing punctuation off the URL", () => {
    expect(splitLinks("no links here")).toEqual([{ kind: "text", text: "no links here" }])
    const segs = splitLinks("go to https://a.bc/d.")
    expect(segs[1]).toEqual({ kind: "link", url: "https://a.bc/d", text: "a.bc/d" })
    expect(segs[2]).toEqual({ kind: "text", text: "." })
  })
})
```

- [ ] **Step 2: Run to verify failure**, then implement `linkify.tsx`:

```tsx
/**
 * Cuttlefish Talk — linkify plain transcript text (Mission Control).
 *
 * The voice pipeline strips markdown, so URLs arrive as bare text. splitLinks()
 * is the pure splitter (unit-tested); <Linkified> renders the segments with
 * tappable anchors (pointer-events re-enabled — the transcript overlay is
 * pointer-events:none).
 */
import type { JSX } from "react"

export type LinkSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string; text: string }

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g

export function splitLinks(text: string): LinkSegment[] {
  const out: LinkSegment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0]
    // Trailing sentence punctuation belongs to the prose, not the URL.
    const trimmed = url.replace(/[.,;:!?]+$/, "")
    const tail = url.slice(trimmed.length)
    url = trimmed
    const start = m.index ?? 0
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) })
    out.push({ kind: "link", url, text: url.replace(/^https?:\/\//, "") })
    last = start + m[0].length - tail.length
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) })
  return out.length ? out : [{ kind: "text", text }]
}

export function Linkified({ text }: { text: string }): JSX.Element {
  const segs = splitLinks(text)
  return (
    <>
      {segs.map((s, i) =>
        s.kind === "link" ? (
          // eslint-disable-next-line react/no-array-index-key
          <a key={i} className="talk-link" href={s.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
            {s.text}
          </a>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  )
}
```

Run linkify tests → PASS.

- [ ] **Step 3: Keep full reply text on finalize**

1. `transcript.tsx` — extend the entry type:

```ts
export interface TranscriptEntry {
  id: string
  role: "user" | "assistant"
  text: string
  partial?: boolean
  seg?: number
  /** Full reply text (history rail); `text` stays the live caption sentence. */
  full?: string
}
```

2. `use-talk.ts` — in `speakReplyIfNeeded`, the `finalize` closure (line ~420) captures the full text:

```ts
      const fullText = stripMarkdown(turnTextRef.current).trim()
      const finalize = () => {
        if (!asstId) return
        setEntries((prev) =>
          prev.map((e) => (e.id === asstId ? { ...e, partial: false, full: fullText || e.text } : e)),
        )
      }
```

(The existing `const text = stripMarkdown(turnTextRef.current).trim()` a few lines below can reuse `fullText` — deduplicate.)
3. `rehydrate.ts` — `messagesToEntries` pushes `{ id, role, text, partial: false, full: text }`.

- [ ] **Step 4: History rail component**

`history-rail.tsx`:

```tsx
/**
 * Cuttlefish Talk — conversation history rail (Mission Control).
 *
 * The live caption stays cinematic (latest exchange only); this collapsible
 * overlay is the memory — every exchange of the talk session, scrollable, with
 * tappable links. Newest at the bottom; opens scrolled to the end.
 */
import { useEffect, useRef } from "react"
import type { JSX } from "react"
import type { TranscriptEntry } from "./transcript"
import { Linkified } from "./linkify"

export interface HistoryRailProps {
  entries: TranscriptEntry[]
  open: boolean
  onClose: () => void
}

export function HistoryRail({ entries, open, onClose }: HistoryRailProps): JSX.Element | null {
  const endRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" })
  }, [open, entries.length])

  if (!open) return null
  return (
    <div className="history-rail" role="log" aria-label="Conversation history">
      <button type="button" className="history-rail__close" onClick={onClose} aria-label="Close history">
        ×
      </button>
      <div className="history-rail__scroll">
        {entries.map((e) => (
          <div key={e.id} className={`history-rail__row history-rail__row--${e.role}`}>
            <Linkified text={e.full ?? e.text} />
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Mount in page.tsx + styles**

1. `page.tsx`: add local state `const [historyOpen, setHistoryOpen] = useState(false)`; a toggle button in the top bar next to the mute toggle (reuse the top bar's icon-button classes — copy the mute button's structure, label "History", a simple clock/list glyph or the text "⋯"); render `<HistoryRail entries={talk.entries} open={historyOpen} onClose={() => setHistoryOpen(false)} />` above the transcript overlay.
2. `tracker.css` additions (theme tokens only — match the file's existing custom-property usage, e.g. the vars used by `.transcript`):

```css
.history-rail {
  position: absolute;
  inset: calc(env(safe-area-inset-top, 0px) + 56px) 12px calc(env(safe-area-inset-bottom, 0px) + 120px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  backdrop-filter: blur(18px);
  background: color-mix(in srgb, var(--color-bg-primary, #111) 78%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-text-primary, #fff) 10%, transparent);
}
.history-rail__scroll { overflow-y: auto; padding: 20px 18px; display: flex; flex-direction: column; gap: 10px; }
.history-rail__row { max-width: 88%; font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
.history-rail__row--user { align-self: flex-end; opacity: 0.75; text-align: right; }
.history-rail__row--assistant { align-self: flex-start; }
.history-rail__close {
  position: absolute; top: 8px; right: 10px; z-index: 1;
  background: none; border: none; font-size: 20px; cursor: pointer; opacity: 0.6;
}
.talk-link { pointer-events: auto; text-decoration: underline; text-underline-offset: 3px; }
```

(Check `tracker.css`/`globals.css` for the real token names — `--color-bg-primary` etc. must match what the Ledger theme defines; grep for `color-mix` usage in the package and copy its pattern.)

- [ ] **Step 6: Full web tests + typecheck + commit**

Run: `pnpm -C packages/web test -- --run && pnpm -C packages/web exec tsc --noEmit`

```bash
git add packages/web/src/routes/talk/linkify.tsx packages/web/src/routes/talk/__tests__/linkify.test.tsx packages/web/src/routes/talk/history-rail.tsx packages/web/src/routes/talk/transcript.tsx packages/web/src/routes/talk/use-talk.ts packages/web/src/routes/talk/rehydrate.ts packages/web/src/routes/talk/page.tsx packages/web/src/routes/talk/tracker.css
git commit -m "feat(talk-web): history rail with tappable links; finalize entries with full reply text"
```

---

### Task 10: Full build + integration smoke on an isolated gateway (port 7878)

**Files:**
- Create: `packages/cuttlefish/scripts/talk-graph-smoke.sh` (committed, reusable)

- [ ] **Step 1: Build the worktree**

Run: `cd <worktree> && pnpm build`
Expected: clean. ⚠️ Never `pnpm --filter @cuttlefish/web build --force` (vite rejects `--force` and ships a stale web/out). The cuttlefish-cli build copies `web/out` → `dist/web`.

- [ ] **Step 2: Write the smoke script**

`packages/cuttlefish/scripts/talk-graph-smoke.sh`:

```bash
#!/usr/bin/env bash
# Talk Mission Control smoke: boots an ISOLATED gateway (throwaway CUTTLEFISH_HOME,
# non-8888 port), builds a 2-level delegation tree via the talk APIs, and
# asserts the graph snapshot + delegate validation behave. Engine turns may
# error in the throwaway home — irrelevant; this tests session/graph plumbing.
set -euo pipefail

PORT="${PORT:-7878}"
HOME_DIR="$(mktemp -d /tmp/cuttlefish-mc-smoke.XXXXXX)"
DIST="$(cd "$(dirname "$0")/.." && pwd)/dist/bin/cuttlefish.js"
BASE="http://127.0.0.1:${PORT}"

echo "CUTTLEFISH_HOME=${HOME_DIR} port=${PORT}"
CUTTLEFISH_HOME="${HOME_DIR}" GATEWAY_PORT="${PORT}" node "${DIST}" start &
GW_PID=$!
trap 'kill ${GW_PID} 2>/dev/null || true; rm -rf "${HOME_DIR}"' EXIT

for i in $(seq 1 30); do
  curl -fsS "${BASE}/api/status" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "${BASE}/api/status" >/dev/null

TALK=$(curl -fsS -X POST "${BASE}/api/talk/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["sessionId"])')
echo "talk session: ${TALK}"

D1=$(curl -fsS -X POST "${BASE}/api/talk/delegate" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"new\",\"label\":\"Thread A\",\"brief\":\"Reply with the single word ok.\"}")
COO1=$(echo "${D1}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["created"] is True;print(d["threadId"])')
echo "coo1: ${COO1}"

curl -fsS -X POST "${BASE}/api/talk/delegate" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"new\",\"label\":\"Thread B\",\"brief\":\"Reply with the single word ok.\"}" >/dev/null

# grandchild under COO1 (what a COO delegating to an employee does)
curl -fsS -X POST "${BASE}/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Reply ok.\",\"parentSessionId\":\"${COO1}\"}" >/dev/null

GRAPH=$(curl -fsS "${BASE}/api/talk/graph?root=${TALK}")
echo "${GRAPH}" | python3 -c '
import sys, json
g = json.load(sys.stdin)
nodes = g["nodes"]
assert len(nodes) == 3, f"expected 3 nodes, got {len(nodes)}: {nodes}"
depths = sorted(n["depth"] for n in nodes)
assert depths == [1, 1, 2], f"bad depths: {depths}"
labels = {n["label"] for n in nodes if n["depth"] == 1}
assert labels == {"Thread A", "Thread B"}, f"bad labels: {labels}"
print("graph snapshot OK:", [(n["label"], n["depth"], n["status"]) for n in nodes])
'

# bad thread id → 400 with roster
CODE=$(curl -s -o /tmp/delegate-err.json -w '%{http_code}' -X POST "${BASE}/api/talk/delegate" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"bogus\",\"brief\":\"x\"}")
test "${CODE}" = "400"
python3 -c 'import json;d=json.load(open("/tmp/delegate-err.json"));assert d.get("threads"),d;print("delegate roster error OK:",[t["label"] for t in d["threads"]])'

echo "SMOKE PASSED"
```

`chmod +x packages/cuttlefish/scripts/talk-graph-smoke.sh`

Note: verify the env var names first — check how the gateway reads home/port (`grep -rn "CUTTLEFISH_HOME\|GATEWAY_PORT" packages/cuttlefish/src/shared/paths.ts packages/cuttlefish/src/bin packages/cuttlefish/src/gateway/server.ts | head`). If the port comes only from config.yaml, pre-seed `${HOME_DIR}/config.yaml` with `gateway: { port: 7878 }` before starting instead of the env var. Also: a fresh CUTTLEFISH_HOME may trigger onboarding seeding — that's fine (it's template-seeded automatically on start).

- [ ] **Step 3: Run the smoke**

Run: `bash packages/cuttlefish/scripts/talk-graph-smoke.sh`
Expected: `graph snapshot OK … delegate roster error OK … SMOKE PASSED`. The two COO sessions will actually run engine turns (claude CLI with the throwaway home) — they may error; the graph assertions don't depend on turn success. If `talk:focus`-dependent label timing makes a flake, the labels come from `updateSession(title)` synchronously in delegate — no race.

- [ ] **Step 4: Commit**

```bash
git add packages/cuttlefish/scripts/talk-graph-smoke.sh
git commit -m "test(talk): isolated-gateway smoke for delegate + graph snapshot"
```

---

### Task 11: Browser verification + final sweep

**Files:** none (verification) + any fixes it surfaces

- [ ] **Step 1: Boot the isolated gateway for manual use**

```bash
HOME_DIR=$(mktemp -d /tmp/cuttlefish-mc-ui.XXXXXX)
CUTTLEFISH_HOME="${HOME_DIR}" GATEWAY_PORT=7878 node packages/cuttlefish/dist/bin/cuttlefish.js start &
```

(Same port-config caveat as Task 10. Rebuild first if any source changed: `pnpm build`.)

- [ ] **Step 2: Browser pass (Claude-in-Chrome) on `http://localhost:7878/talk`**

Verify, with screenshots:
1. Page loads; orb renders; engine badge shows sonnet.
2. Type-to-talk: "Spawn a thread to check disk space, and a second thread to list the org" → AURA acks; two satellites appear with labels; thread panel lists both.
3. Wait for completion → satellites DIM (do not disappear).
4. The roster grounding: send "follow up on the disk space thread — how much is free?" → the SAME satellite relights (no third thread spawned). This is the headline misrouting fix.
5. Ask "give me a link to the anthropic docs" → a tappable link card appears (and/or the link is tappable in the history rail); AURA does not speak the URL.
6. History toggle opens the rail; full conversation scrolls; links are anchors.
7. If a COO spawns an employee child (ask: "have the team check two things in parallel"), mini-dots appear under that satellite.

- [ ] **Step 3: Full final test sweep**

Run: `pnpm -C packages/cuttlefish exec tsc --noEmit && pnpm -C packages/web exec tsc --noEmit && pnpm -C packages/cuttlefish test -- --run && pnpm -C packages/web test -- --run && pnpm build`
Expected: everything green.

- [ ] **Step 4: Kill the test gateway, clean tmp dirs**

```bash
pkill -f "cuttlefish-mc-ui" 2>/dev/null; pkill -f "GATEWAY_PORT=7878" 2>/dev/null || true
```

(Verify with `lsof -ti :7878` — must be empty. NEVER touch port 8888.)

- [ ] **Step 5: Final commit (fixes from verification, if any)**

```bash
git add -A && git commit -m "fix(talk): mission-control verification fixes" # only if there are changes
```

---

## Deploy notes (NOT part of this plan — the operator's call)

- Merge `talk-mission-control` → main, rebuild, restart the 8888 daemon (`npm run cuttlefish start -- --daemon` from `~/Projects/cuttlefish` after `cuttlefish stop` — never `cuttlefish restart`).
- Swap the live `~/.cuttlefish/talk/orchestrator-persona.md` with the new template (hot-reloads instantly).
- `config.yaml` currently pins `talk.orchestratorModel`; if it says `haiku`, change to `sonnet` (the new default only applies when unset).

## Self-review notes

- Spec coverage: delegate endpoint (T2), roster (T3), graph + deltas + snapshot (T4), never-hide/dim + multi-level constellation (T7/T8), cards widened (T1) + cap 6 (T7), history + links (T9), per-sentence TTS + seq contract (T5), sonnet + persona (T6), isolated-port testing (T10/T11). Auto-cards: consolidated into the graph per spec §3.
- Type consistency: `TalkGraphNode` (backend) and `GraphNode`/`TalkGraphNodeWire` (frontend) carry identical fields; `delegateToThread` returns `threadId`/`created` used by both the route and smoke script; `speak(…, opts)` return type updated in `Tts` interface and kokoro implementation together.
