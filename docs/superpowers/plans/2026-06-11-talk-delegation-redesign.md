# /talk Delegation & Work-UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Center the conversation on the viewport, and make delegation read like real, followable communication — live thread cards in the stream, a real hierarchy tree in the rail, and a slide-in drawer with breadcrumbs that can descend into nested (grandchild) sessions.

**Architecture:** The graph store stays the single structural source. A new client-side *thread-activity* store overlays live "now doing" lines + report excerpts, fed from `session:delta` / `session:completed` WS events that already arrive for every tree node but are currently discarded. The `delegated` one-line chip is replaced by a live **ThreadCard** stream row; the WorkDock chips+mini-dots become a **work tree** (real labeled hierarchy); the centered session-peek modal becomes a right-edge **thread drawer** with breadcrumbs + descend navigation. One additive backend field (`TalkGraphNode.briefExcerpt`) carries "what was asked".

**Tech Stack:** React 18 + TypeScript, CSS (Ledger tokens + talk tokens), vitest + @testing-library/react, Node/TS gateway (packages/cuttlefish).

**Branch:** `talk-conversation-first` in `~/Projects/cuttlefish-mission-control`. Spec: `docs/superpowers/specs/2026-06-11-talk-delegation-redesign-design.md`.

**Hard constraints (carry into every task):**
- NEVER touch the live gateway (port 8888), `~/Projects/cuttlefish`, or `~/.cuttlefish`. All work in `~/Projects/cuttlefish-mission-control`.
- The repo is PUBLIC: no PII/real names in code or commit messages. No `Co-Authored-By` lines.
- Web tests: `cd packages/web && npx vitest run <file>` . Cuttlefish tests: `cd packages/cuttlefish && npx vitest run <file>`. NEVER build web with `--force`.

---

### Task 1: Backend — `briefExcerpt` on TalkGraphNode

The "what was asked" line for every node, at every depth, surviving reload via the snapshot.

**Files:**
- Modify: `packages/cuttlefish/src/talk/graph.ts` (TalkGraphNode interface ~line 17, `toGraphNode` ~line 47)
- Modify: `packages/web/src/routes/talk/protocol.ts` (the talk graph node type, ~line 68)
- Modify: `packages/web/src/routes/talk/graph-store.ts` (GraphNode interface, line 14)
- Test: `packages/cuttlefish/src/talk/graph.test.ts` (or `__tests__` — follow where the existing graph tests live; `grep -rn "toGraphNode" packages/cuttlefish --include="*.test.ts"`)

- [ ] **Step 1: Write the failing test** (add to the existing graph test file)

```ts
describe("briefExcerpt", () => {
  const base = {
    id: "c1", parentSessionId: "root", title: "Lead", employee: null,
    status: "running", lastActivity: "2026-06-11T00:00:00Z",
  } as unknown as Session

  it("carries a whitespace-flattened excerpt of the session prompt", () => {
    const s = { ...base, prompt: "Audit the funnel\n\nand   split the fixes" } as Session
    expect(toGraphNode(s, 1).briefExcerpt).toBe("Audit the funnel and split the fixes")
  })

  it("truncates long prompts to 140 chars with an ellipsis", () => {
    const s = { ...base, prompt: "x".repeat(400) } as Session
    const out = toGraphNode(s, 1).briefExcerpt!
    expect(out.length).toBeLessThanOrEqual(140)
    expect(out.endsWith("…")).toBe(true)
  })

  it("omits the field when the prompt is empty", () => {
    const s = { ...base, prompt: "" } as Session
    expect(toGraphNode(s, 1).briefExcerpt).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/cuttlefish && npx vitest run src/talk/graph.test.ts` → FAIL (`briefExcerpt` does not exist).

- [ ] **Step 3: Implement** — in `graph.ts`:

```ts
// In the TalkGraphNode interface, after `lastActivity`:
  /** First ~140 chars of the session's prompt — "what was asked" of this node. */
  briefExcerpt?: string;
```

```ts
/** Whitespace-flattened, ≤140-char excerpt of a prompt (undefined when empty). */
function briefExcerptOf(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > 140 ? flat.slice(0, 139).trimEnd() + "…" : flat;
}

export function toGraphNode(s: Session, depth: number): TalkGraphNode {
  const briefExcerpt = briefExcerptOf(s.prompt);
  return {
    id: s.id,
    parentId: s.parentSessionId ?? null,
    depth,
    label: nodeLabel(s),
    employee: s.employee ?? null,
    status: s.status,
    lastActivity: s.lastActivity,
    ...(briefExcerpt ? { briefExcerpt } : {}),
  };
}
```

Mirror the field on the web side — `protocol.ts` talk graph node type and `graph-store.ts` `GraphNode` both gain:

```ts
  /** First ~140 chars of the session's prompt — "what was asked" of this node. */
  briefExcerpt?: string
```

- [ ] **Step 4: Run tests** — cuttlefish graph tests PASS; also `npx tsc --noEmit` in both packages.
- [ ] **Step 5: Commit** — `feat(talk): briefExcerpt on graph nodes — what each thread was asked`

---

### Task 2: Centering — the rail becomes an overlay at all widths

**Files:**
- Modify: `packages/web/src/routes/talk/talk-layout.css` (`.talk-rail` block, lines 91–113)

- [ ] **Step 1: Replace the `.talk-rail` rules.** Delete the current `.talk-rail { … }` block AND the entire `@media (max-width: 719px) { … }` block that overrides it; replace with:

```css
/* The rail floats over the stage edge at ALL widths so it never steals column
   width — the transcript column centers on the VIEWPORT, not a shrunken cell.
   (Operator requirement: chat horizontally centered on screen.) The wrapper is
   pointer-events:none so the transcript margin stays scrollable through it. */
.talk-rail {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: var(--z-rail);
  display: flex;
  align-items: center;
  /* 10px = no-inset floor for the safe-area right edge. */
  padding-right: max(env(safe-area-inset-right), 10px);
  pointer-events: none;
}
.talk-rail > * {
  pointer-events: auto;
}
```

- [ ] **Step 2: Verify no other rule depends on the rail being in-flow** — `grep -rn "talk-rail" packages/web/src` (expect: page.tsx markup + this CSS only).
- [ ] **Step 3: Run web tests + build** — `cd packages/web && npx vitest run && npx tsc --noEmit`.
- [ ] **Step 4: Commit** — `fix(talk): transcript centers on the viewport — rail floats at all widths`

---

### Task 3: thread-activity store + use-talk wiring

Live "now doing" lines + report excerpts for every tree node, from the WS data we already receive.

**Files:**
- Create: `packages/web/src/routes/talk/thread-activity.ts`
- Test: `packages/web/src/routes/talk/__tests__/thread-activity.test.ts`
- Modify: `packages/web/src/routes/talk/use-talk.ts` (child `session:delta` branch ~line 656; `session:completed` handler ~line 704; return value + provider type)
- Modify: `packages/web/src/routes/talk/talk-provider.tsx` (expose `activity` on the context — follow how `graph` is exposed)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest"
import { activityFor, excerpt, threadActivityReducer } from "../thread-activity"

describe("excerpt", () => {
  it("strips markdown, urls and uuids, flattens whitespace", () => {
    const raw = "**Done!** See https://x.test/r `code` 0b6a7c1e-1111-2222-3333-444455556666\n\nNext   steps"
    expect(excerpt(raw, 140)).toBe("Done! See Next steps")
  })
  it("caps at max chars with an ellipsis", () => {
    expect(excerpt("word ".repeat(60), 40).length).toBeLessThanOrEqual(40)
    expect(excerpt("word ".repeat(60), 40).endsWith("…")).toBe(true)
  })
  it("returns empty string for empty/noise-only input", () => {
    expect(excerpt("``` ```", 140)).toBe("")
  })
})

describe("activityFor", () => {
  it("maps delegation spawns", () => {
    expect(activityFor({ toolName: "Bash", input: 'curl -X POST /api/sessions {"parentSessionId":"x"}' })).toBe("delegating…")
  })
  it("maps file reads and edits", () => {
    expect(activityFor({ toolName: "Read" })).toBe("reading…")
    expect(activityFor({ toolName: "Edit" })).toBe("editing…")
  })
  it("maps web work and shell, defaults to working", () => {
    expect(activityFor({ toolName: "WebSearch" })).toBe("searching the web…")
    expect(activityFor({ toolName: "Bash", input: "ls -la" })).toBe("running commands…")
    expect(activityFor({ toolName: "SomethingNew" })).toBe("working…")
  })
})

describe("threadActivityReducer", () => {
  it("sets activity, then report clears the live line", () => {
    let m = threadActivityReducer(new Map(), { type: "activity", id: "a", text: "reading…" })
    expect(m.get("a")).toEqual({ activity: "reading…" })
    m = threadActivityReducer(m, { type: "report", id: "a", text: "All done." })
    expect(m.get("a")).toEqual({ reportExcerpt: "All done." })
  })
  it("is referentially stable on no-op updates", () => {
    const m1 = threadActivityReducer(new Map(), { type: "activity", id: "a", text: "x" })
    const m2 = threadActivityReducer(m1, { type: "activity", id: "a", text: "x" })
    expect(m2).toBe(m1)
  })
  it("drops empty report excerpts but still clears activity", () => {
    let m = threadActivityReducer(new Map(), { type: "activity", id: "a", text: "x" })
    m = threadActivityReducer(m, { type: "report", id: "a", text: "" })
    expect(m.get("a")).toEqual({})
  })
})
```

- [ ] **Step 2: Run to verify FAIL** — `cd packages/web && npx vitest run src/routes/talk/__tests__/thread-activity.test.ts`

- [ ] **Step 3: Implement `thread-activity.ts`**

```ts
/**
 * Cuttlefish Talk — thread-activity overlay store (delegation redesign).
 *
 * Advisory, client-side overlay keyed by sessionId: the live "now doing" line
 * and the final report excerpt for every node of the delegation tree. Fed in
 * use-talk from the `session:delta` / `session:completed` WS events that arrive
 * for every tree node (graph-store stays the structural source — a missing
 * entry here just renders nothing).
 */

export interface ThreadActivity {
  /** Short live "now doing" line (present while the node works). */
  activity?: string
  /** Sanitized excerpt of the node's final result (set on completion). */
  reportExcerpt?: string
}

export type ActivityMap = Map<string, ThreadActivity>

export type ActivityAction =
  | { type: "activity"; id: string; text: string }
  | { type: "report"; id: string; text: string }

/** Strip markdown/URLs/UUIDs, flatten whitespace, cap at `max` chars. */
export function excerpt(text: string, max: number): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, " ")
    .replace(/[*_#`>|~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!flat) return ""
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat
}

export interface ActivityDeltaLike {
  toolName?: string
  content?: string | number
  input?: string
}

/** Map a child session's tool_use delta to a short human "now doing" line. */
export function activityFor(delta: ActivityDeltaLike): string {
  const name = typeof delta.toolName === "string" ? delta.toolName : ""
  const input = typeof delta.input === "string" ? delta.input : ""
  const hay = `${name} ${typeof delta.content === "string" ? delta.content : ""} ${input}`.toLowerCase()
  // Spawning a sub-session — the moment nested delegation begins.
  if (hay.includes("/api/sessions") && hay.includes("parentsessionid")) return "delegating…"
  if (/^(read|glob|grep)$/i.test(name)) return "reading…"
  if (/^(write|edit|notebookedit)$/i.test(name)) return "editing…"
  if (/^(websearch|webfetch)$/i.test(name)) return "searching the web…"
  if (/^(task|agent)$/i.test(name)) return "delegating…"
  if (/^bash$/i.test(name)) return "running commands…"
  return "working…"
}

/** Pure transitions on the sessionId → ThreadActivity map. */
export function threadActivityReducer(map: ActivityMap, action: ActivityAction): ActivityMap {
  const prev = map.get(action.id)
  if (action.type === "activity") {
    if (prev?.activity === action.text) return map
    const next = new Map(map)
    next.set(action.id, { ...prev, activity: action.text })
    return next
  }
  // report: the live line ends; keep only a non-empty excerpt.
  const text = excerpt(action.text, 140)
  const entry: ThreadActivity = text ? { reportExcerpt: text } : {}
  if (prev && !prev.activity && prev.reportExcerpt === entry.reportExcerpt) return map
  const next = new Map(map)
  next.set(action.id, entry)
  return next
}
```

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Wire into use-talk.** In `use-talk.ts`:

Add near the other reducers (follow `dispatchGraph` pattern):

```ts
const [activity, dispatchActivity] = useReducer(threadActivityReducer, new Map() as ActivityMap)
```

In the `session:delta` handler, the child branch currently reads:

```ts
} else if (isChild && s) {
  dispatchGraph({ type: "setStatus", id: s, status: "running" }) // keep working
}
```

becomes:

```ts
} else if (isChild && s) {
  dispatchGraph({ type: "setStatus", id: s, status: "running" }) // keep working
  // Surface what the worker is doing — the delegation-card live line.
  if (ev.type === "tool_use") {
    dispatchActivity({ type: "activity", id: s, text: activityFor({ toolName: ev.toolName, content: ev.content, input: ev.input }) })
  } else if (ev.type === "text") {
    dispatchActivity({ type: "activity", id: s, text: "writing…" })
  }
}
```

In the `session:completed` handler (~line 704), where the child path updates the graph, additionally dispatch the report excerpt:

```ts
if (isChild && s) {
  const ev = payload as SessionCompletedEvent
  dispatchActivity({ type: "report", id: s, text: ev.result ?? "" })
}
```

(Read the existing handler first and place this alongside the existing child-status logic without disturbing it; import `activityFor` and `threadActivityReducer`/`ActivityMap` from `./thread-activity`.)

Expose `activity` in the use-talk return object and on the talk context in `talk-provider.tsx` exactly the way `graph` is exposed.

- [ ] **Step 6: Remove the `reported` chip dispatch.** In the `TALK_EVENTS.graph` handler, delete the `else if (ev.change === "completed" && !n.attached) { addSystem({ … event: "reported" … }) }` branch (the ThreadCard's report line replaces it — Task 4). Keep `delegated`, `attached`, `detached`.
- [ ] **Step 7: Run the full talk test suite** — `cd packages/web && npx vitest run src/routes/talk` (some use-talk tests may assert the reported chip; update those tests to expect no `reported` system row).
- [ ] **Step 8: Commit** — `feat(talk): thread-activity store — live now-doing lines + report excerpts per node`

---

### Task 4: ThreadCard — delegation as communication in the stream

**Files:**
- Create: `packages/web/src/routes/talk/thread-card.tsx`
- Create: `packages/web/src/routes/talk/thread-card.css`
- Test: `packages/web/src/routes/talk/__tests__/thread-card.test.tsx`
- Modify: `packages/web/src/routes/talk/conversation-stream.tsx` (render ThreadCard for `delegated` rows; new props)
- Modify: `packages/web/src/routes/talk/page.tsx` (pass `graph` + `activity` to ConversationStream)

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ThreadCard } from "../thread-card"
import type { GraphNode } from "../graph-store"

const node = (over: Partial<GraphNode>): GraphNode => ({
  id: "t1", parentId: "root", depth: 1, label: "Platform Lead", employee: null,
  status: "running", lastActivity: "2026-06-11T00:00:00Z", ...over,
})

describe("ThreadCard", () => {
  it("renders route, brief, live activity and status", () => {
    const graph = [node({ briefExcerpt: "Audit the funnel" })]
    const activity = new Map([["t1", { activity: "reading…" }]])
    render(<ThreadCard threadId="t1" graph={graph} activity={activity} fallbackLabel="Platform Lead" />)
    expect(screen.getByText(/AURA → Platform Lead/)).toBeInTheDocument()
    expect(screen.getByText(/Audit the funnel/)).toBeInTheDocument()
    expect(screen.getByText("reading…")).toBeInTheDocument()
    expect(screen.getByText("working")).toBeInTheDocument()
  })

  it("renders nested sub-thread rows from the graph, indented by depth", () => {
    const graph = [
      node({}),
      node({ id: "g1", parentId: "t1", depth: 2, label: "Funnel Analyst", status: "running" }),
      node({ id: "gg1", parentId: "g1", depth: 3, label: "Query Runner", status: "idle" }),
    ]
    render(<ThreadCard threadId="t1" graph={graph} activity={new Map()} fallbackLabel="Platform Lead" />)
    expect(screen.getByText(/Funnel Analyst/)).toBeInTheDocument()
    expect(screen.getByText(/Query Runner/)).toBeInTheDocument()
    const rows = screen.getAllByRole("button", { name: /open thread/i })
    expect(rows.length).toBeGreaterThanOrEqual(3) // head + 2 sub-rows
  })

  it("shows the report excerpt and settles when completed", () => {
    const graph = [node({ status: "idle" })]
    const activity = new Map([["t1", { reportExcerpt: "Funnel audit done: 3 fixes." }]])
    const { container } = render(
      <ThreadCard threadId="t1" graph={graph} activity={activity} fallbackLabel="Platform Lead" />,
    )
    expect(screen.getByText(/Funnel audit done/)).toBeInTheDocument()
    expect(container.querySelector(".tcard")?.getAttribute("data-status")).toBe("done")
  })

  it("opens the thread on click", async () => {
    const onOpenThread = vi.fn()
    render(<ThreadCard threadId="t1" graph={[node({})]} activity={new Map()} fallbackLabel="L" onOpenThread={onOpenThread} />)
    await userEvent.click(screen.getAllByRole("button", { name: /open thread/i })[0])
    expect(onOpenThread).toHaveBeenCalledWith("t1")
  })

  it("renders a settled fallback when the node is gone from the graph", () => {
    render(<ThreadCard threadId="zz" graph={[]} activity={new Map()} fallbackLabel="Old Thread" />)
    expect(screen.getByText(/AURA → Old Thread/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement `thread-card.tsx`**

```tsx
/**
 * Cuttlefish Talk — ThreadCard (delegation as communication).
 *
 * A live delegation row in the conversation stream, replacing the one-line
 * "⟶ delegated" chip. Shows the route (AURA → lead), what was asked (brief
 * excerpt), what the worker is doing right now (live activity line), nested
 * sub-threads as indented rows (any depth — grandchildren included), and the
 * report excerpt once the thread completes. Clicking the head or any sub-row
 * opens that session in the thread drawer.
 *
 * Structural data comes from the live graph (single source); the live/report
 * lines come from the advisory thread-activity overlay. A node missing from
 * the graph (dismissed/aged out) renders a settled head from fallbackLabel.
 */
import type { CSSProperties } from "react"
import type { GraphNode } from "./graph-store"
import { isWorking, childrenOf } from "./graph-store"
import type { ActivityMap } from "./thread-activity"
import { channelHue } from "./channel-identity"
import "./thread-card.css"

export interface ThreadCardProps {
  threadId: string
  graph: GraphNode[]
  activity: ActivityMap
  /** Label from the stream row — used when the node left the graph. */
  fallbackLabel: string
  hue?: number
  onOpenThread?: (id: string) => void
}

type StatusKind = "working" | "waiting" | "done" | "error"

function statusOf(node: GraphNode | undefined): StatusKind {
  if (!node) return "done"
  if (node.status === "error" || node.status === "failed") return "error"
  if (node.status === "waiting") return "waiting"
  if (isWorking(node)) return "working"
  return "done"
}

/** DFS the subtree under `rootId` (excluding the root), depth-first order. */
export function subtreeRows(rootId: string, graph: GraphNode[]): GraphNode[] {
  const out: GraphNode[] = []
  const walk = (id: string) => {
    for (const child of childrenOf(graph, id)) {
      out.push(child)
      walk(child.id)
    }
  }
  walk(rootId)
  return out
}

function StatusPill({ kind }: { kind: StatusKind }) {
  return (
    <span className="tcard__pill" data-kind={kind} key={kind}>
      {kind === "working" ? "working" : kind === "waiting" ? "waiting" : kind === "error" ? "error" : "done"}
    </span>
  )
}

function SubRow({
  node,
  baseDepth,
  activity,
  onOpenThread,
}: {
  node: GraphNode
  baseDepth: number
  activity: ActivityMap
  onOpenThread?: (id: string) => void
}) {
  const kind = statusOf(node)
  const live = kind === "working" || kind === "waiting" ? activity.get(node.id)?.activity : undefined
  const indent = Math.min(Math.max(node.depth - baseDepth, 1), 3)
  const hue = channelHue(node.label || node.id)
  return (
    <button
      type="button"
      className="tcard__sub"
      style={{ ["--tc-indent" as string]: String(indent), ["--tc-hue" as string]: String(hue) } as CSSProperties}
      data-status={kind}
      aria-label={`Open thread: ${node.label}`}
      onClick={onOpenThread ? () => onOpenThread(node.id) : undefined}
    >
      <span className="tcard__connector" aria-hidden="true">↳</span>
      <span className="tcard__dot" aria-hidden="true" />
      <span className="tcard__sub-main">
        <span className="tcard__sub-route">→ {node.label}</span>
        {live ? <span className="tcard__live" key={live}>{live}</span> : null}
      </span>
      <StatusPill kind={kind} />
    </button>
  )
}

export function ThreadCard({ threadId, graph, activity, fallbackLabel, hue, onOpenThread }: ThreadCardProps) {
  const node = graph.find((n) => n.id === threadId)
  const kind = statusOf(node)
  const label = node?.label || fallbackLabel
  const cardHue = hue ?? channelHue(label || threadId)
  const entry = activity.get(threadId)
  const live = kind === "working" || kind === "waiting" ? entry?.activity : undefined
  const report = entry?.reportExcerpt
  const subs = node ? subtreeRows(threadId, graph) : []

  return (
    <div
      className="tcard"
      data-status={kind}
      style={{ ["--tc-hue" as string]: String(cardHue) } as CSSProperties}
    >
      <button
        type="button"
        className="tcard__head"
        aria-label={`Open thread: ${label}`}
        onClick={onOpenThread ? () => onOpenThread(threadId) : undefined}
      >
        <span className={`tcard__dot${kind === "working" ? " tcard__dot--working" : ""}`} aria-hidden="true" />
        <span className="tcard__route">AURA → {label}</span>
        <StatusPill kind={kind} />
      </button>

      {node?.briefExcerpt ? <p className="tcard__brief">“{node.briefExcerpt}”</p> : null}
      {live ? (
        <p className="tcard__live tcard__live--head" key={live}>
          {live}
        </p>
      ) : null}

      {subs.length > 0 ? (
        <div className="tcard__subs" role="list" aria-label={`${subs.length} sub-threads`}>
          {subs.map((sub) => (
            <SubRow key={sub.id} node={sub} baseDepth={node?.depth ?? 1} activity={activity} onOpenThread={onOpenThread} />
          ))}
        </div>
      ) : null}

      {report ? <p className="tcard__report">⟵ “{report}”</p> : null}
    </div>
  )
}
```

Note: `childrenOf` exists in `graph-store.ts` — verify its export name (`childrenOf(nodes, parentId)`); adjust the call argument order to match the real signature.

- [ ] **Step 4: Implement `thread-card.css`** (consume `.talk-root` tokens; reduced-motion fallbacks)

```css
/**
 * Cuttlefish Talk — ThreadCard (delegation as communication).
 * Glassy, hue-tinted, fluid: sub-rows grow the card via a 0fr→1fr grid
 * transition; the live line crossfades on change (keyed remount).
 */
.tcard {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, hsl(var(--tc-hue) 60% 55%) 22%, var(--separator));
  border-radius: var(--radius-lg, 14px);
  background:
    linear-gradient(180deg, color-mix(in srgb, hsl(var(--tc-hue) 60% 55%) 7%, transparent), transparent 60%),
    var(--material-regular);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  transition:
    opacity var(--motion-enter),
    border-color var(--motion-enter),
    transform var(--motion-enter);
}
.tcard[data-status="done"] {
  opacity: 0.78;
}
.tcard[data-status="error"] {
  border-color: color-mix(in srgb, var(--system-red) 45%, var(--separator));
}

.tcard__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  text-align: left;
  cursor: pointer;
  border-radius: 8px;
}
.tcard__head:hover .tcard__route {
  color: var(--text-primary);
}

.tcard__dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: hsl(var(--tc-hue) 70% 55%);
}
.tcard__dot--working {
  animation: tcard-pulse 1.5s var(--ease-smooth, cubic-bezier(0.4, 0, 0.2, 1)) infinite;
}
@keyframes tcard-pulse {
  0%, 100% { box-shadow: 0 0 0 0 hsl(var(--tc-hue) 70% 55% / 0.45); }
  55% { box-shadow: 0 0 0 6px hsl(var(--tc-hue) 70% 55% / 0); }
}

.tcard__route {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-code);
  font-size: 12px;
  color: var(--text-secondary);
  transition: color var(--motion-exit);
}

.tcard__pill {
  flex: none;
  padding: 2px 8px;
  border-radius: 999px;
  font-family: var(--font-code);
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
  border: 1px solid var(--separator);
  animation: tcard-fade-in var(--motion-enter) both;
}
.tcard__pill[data-kind="working"] {
  color: hsl(var(--tc-hue) 60% 50%);
  border-color: color-mix(in srgb, hsl(var(--tc-hue) 60% 55%) 40%, transparent);
}
.tcard__pill[data-kind="error"] {
  color: var(--system-red);
  border-color: color-mix(in srgb, var(--system-red) 50%, transparent);
}

.tcard__brief {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-primary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tcard__live {
  margin: 0;
  font-family: var(--font-code);
  font-size: 11px;
  color: var(--text-tertiary);
  animation: tcard-fade-in var(--motion-enter) both;
}
.tcard__live::before {
  content: "⋯ ";
  opacity: 0.7;
}

/* sub-thread rows — appear with a fluid height expansion */
.tcard__subs {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tcard__sub {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  align-items: center;
  gap: 7px;
  padding: 4px 6px 4px calc(6px + (var(--tc-indent, 1) - 1) * 14px);
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  animation: tcard-sub-in var(--motion-enter) both;
  transition: background var(--motion-exit);
}
.tcard__sub:hover {
  background: var(--fill-secondary);
}
.tcard__sub .tcard__dot {
  width: 7px;
  height: 7px;
}
.tcard__sub[data-status="working"] .tcard__dot {
  animation: tcard-pulse 1.5s var(--ease-smooth, cubic-bezier(0.4, 0, 0.2, 1)) infinite;
}
.tcard__connector {
  font-size: 11px;
  color: var(--text-quaternary);
}
.tcard__sub-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.tcard__sub-route {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-code);
  font-size: 11.5px;
  color: var(--text-secondary);
}

.tcard__report {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary);
  border-top: 1px solid var(--separator);
  padding-top: var(--space-1);
  animation: tcard-fade-in var(--motion-enter) both;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

@keyframes tcard-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes tcard-sub-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .tcard,
  .tcard__pill,
  .tcard__live,
  .tcard__sub,
  .tcard__report {
    animation: none;
    transition: none;
  }
  .tcard__dot--working,
  .tcard__sub[data-status="working"] .tcard__dot {
    animation: none;
  }
}
```

(If `--radius-lg`, `--font-code`, `--fill-secondary`, `--material-regular`, `--system-red`, `--text-*` token names differ, read `globals.css`/existing talk CSS and use the established names — `work-dock.css` and `cards.css` are the reference.)

- [ ] **Step 5: Render ThreadCards in the stream.** In `conversation-stream.tsx`:
  - Add props: `graph?: GraphNode[]`, `activity?: ActivityMap` (import types).
  - In the row renderer, route `delegated` rows with a `threadId` to ThreadCard; all other system events keep the chip:

```tsx
) : row.kind === "system" && row.event === "delegated" && row.threadId ? (
  <div className="cstream__row cstream__row--thread">
    <ThreadCard
      threadId={row.threadId}
      graph={graph ?? []}
      activity={activity ?? new Map()}
      fallbackLabel={row.label}
      hue={row.hue}
      onOpenThread={onOpenThread}
    />
  </div>
) : (
  <SystemChip row={row} onOpenThread={onOpenThread} />
)
```

  Add to `conversation-stream.css` a `.cstream__row--thread { align-items: stretch; }` rule next to the other row variants.
- [ ] **Step 6: Pass `graph={talk.graph}` and `activity={talk.activity}` from `page.tsx`** to `<ConversationStream …>`.
- [ ] **Step 7: Run tests** — thread-card tests PASS; whole talk suite green (`npx vitest run src/routes/talk`); `npx tsc --noEmit`.
- [ ] **Step 8: Commit** — `feat(talk): ThreadCard — delegation reads as live, followable communication`

---

### Task 5: Work tree — the rail shows the real hierarchy

**Files:**
- Create: `packages/web/src/routes/talk/work-tree.tsx`
- Create: `packages/web/src/routes/talk/work-tree.css`
- Test: `packages/web/src/routes/talk/__tests__/work-tree.test.tsx` (port + extend the existing work-dock tests — find them first: `ls packages/web/src/routes/talk/__tests__/`)
- Modify: `packages/web/src/routes/talk/work-dock-layout.ts` (delete `miniDotsFor` + `MiniDot`; keep the rest)
- Modify: `packages/web/src/routes/talk/page.tsx` (render WorkTree instead of WorkDock; same props)
- Delete: `packages/web/src/routes/talk/work-dock.tsx`, `packages/web/src/routes/talk/work-dock.css` (and their now-replaced tests)

- [ ] **Step 1: Write the failing tests.** Port the existing WorkDock behavioral tests (rename/pin/dismiss/menu/collapse) to `WorkTree`, plus new hierarchy assertions:

```tsx
it("renders depth-2+ descendants as labeled, indented tree rows", () => {
  const graph = [
    n({ id: "t1", depth: 1, label: "Lead", status: "running" }),
    n({ id: "g1", parentId: "t1", depth: 2, label: "Analyst", status: "running" }),
    n({ id: "gg1", parentId: "g1", depth: 3, label: "Runner", status: "idle" }),
  ]
  render(<WorkTree graph={graph} {...baseProps} />)
  expect(screen.getByText("Analyst")).toBeInTheDocument()
  expect(screen.getByText("Runner")).toBeInTheDocument()
})

it("shows the live activity line on working rows", () => {
  const graph = [n({ id: "t1", depth: 1, label: "Lead", status: "running" })]
  const activity = new Map([["t1", { activity: "reading…" }]])
  render(<WorkTree graph={graph} activity={activity} {...baseProps} />)
  expect(screen.getByText("reading…")).toBeInTheDocument()
})

it("opens any node (including a grandchild) on click", async () => { /* click row 'Runner' → onOpenThread('gg1') */ })
```

- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement `work-tree.tsx`.** Start from `work-dock.tsx` (same props + `activity?: ActivityMap`, same side-state/menu/rename/pin/dismiss logic — preserve it verbatim where possible) with these rendering changes:
  - Replace the mini-dots block with a recursive subtree render using `subtreeRows` (import from `thread-card.tsx` — it's exported there; do NOT duplicate it).
  - Each depth-1 node renders a root row (dot + label button + pin + ⋯ menu, as today); each descendant renders a `wt__row wt__row--sub` (indent via `--wt-indent` like ThreadCard, `↳` connector, label, working pulse, live activity line from `activity` when working, click → `onOpenThread(id)`).
  - Collapsed state (idle && !anyWorking, expand on hover/focus-within — same trigger logic): root rows shrink to bare dots; sub-rows collapse to 5px dots stacked tight under their root dot (`wt__row--sub` keeps only the dot visible).
  - Class prefix `wt` (new CSS file modeled on `work-dock.css` glass panel, max-height 72dvh, scroll). Stagger row entrances: `animation-delay: calc(var(--wt-i) * 40ms)` with `--wt-i` set per row index inline.
- [ ] **Step 4: Implement `work-tree.css`** — port the glassy rail container/menu/edit styles from `work-dock.css` under the `wt` prefix; add sub-row indent/connector/live-line styles mirroring `thread-card.css`'s `.tcard__sub`; row enter animation `wt-row-in` (opacity+translateX(6px)→none, `var(--motion-enter)`, with the stagger delay); reduced-motion disables animations.
- [ ] **Step 5: Swap in page.tsx** — replace the WorkDock import/usage with WorkTree, passing `activity={talk.activity}` in addition to current props. Delete `work-dock.tsx`/`work-dock.css` and remove `miniDotsFor`/`MiniDot` from `work-dock-layout.ts` (update its tests; keep `orderDockNodes`, `deriveLabel`, `nodeHue`, `focusNode`, `DockSideMap`).
- [ ] **Step 6: Run** the talk suite + `npx tsc --noEmit` + `grep -rn "work-dock\b\|WorkDock\|miniDotsFor" packages/web/src` → only `work-dock-layout` imports remain (consider renaming the file ONLY if trivial; otherwise leave with a header note that it now serves WorkTree).
- [ ] **Step 7: Commit** — `feat(talk): work tree — the rail shows the real delegation hierarchy, any depth`

---

### Task 6: Thread drawer — breadcrumbs + descend navigation

**Files:**
- Create: `packages/web/src/routes/talk/thread-drawer.tsx`
- Create: `packages/web/src/routes/talk/thread-drawer.css`
- Test: `packages/web/src/routes/talk/__tests__/thread-drawer.test.tsx` (port session-peek tests if any exist + add breadcrumb/descend tests)
- Modify: `packages/web/src/routes/talk/page.tsx` (SessionPeek → ThreadDrawer)
- Delete: `packages/web/src/routes/talk/session-peek.tsx`

- [ ] **Step 1: Write the failing tests** (mock `useSessionChat` + `useTalkContext` the way existing session-peek/talk tests do — check `__tests__` for the established mocking pattern):

```tsx
it("renders the breadcrumb path from the graph", () => {
  // graph: root←t1←g1 ; open g1 → crumbs "AURA ▸ Lead ▸ Analyst"
})
it("navigates up when an ancestor crumb is clicked", () => {
  // click "Lead" crumb → onNavigate("t1")
})
it("lists child sessions and descends on click", () => {
  // open t1 with child g1 → row "Analyst" → onNavigate("g1")
})
it("keeps attach controls and engage composer behavior", () => { /* port from session-peek tests */ })
it("closes on Escape and on scrim click", () => { /* onClose called */ })
```

- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement `thread-drawer.tsx`.** Structure (port `AttachControls`, `EngageComposer`, `headerLabel`, and the `useSessionChat` body logic from `session-peek.tsx` VERBATIM — they are battle-tested; keep their explanatory comments):

```tsx
export interface ThreadDrawerProps {
  sessionId: string | null
  onClose: () => void
  /** Navigate the drawer to another session (breadcrumb up / child descend). */
  onNavigate: (id: string) => void
}
```

  - Render `null` when `sessionId` is null **after** the exit animation: keep an internal `visible` state — on `sessionId` set → mount + animate in (`data-open="true"` next frame); on close → `data-open="false"`, unmount on `transitionend` (fallback timeout `DURATION.slow`).
  - Markup: fixed scrim (`.tdrawer-scrim`, click → `onClose`) + panel `.tdrawer` (`role="dialog"`, `aria-modal`, `aria-label` = header label) anchored right, `width: min(480px, 92vw)`, full height, `--z-overlay`.
  - **Breadcrumbs:** walk `graph` `parentId` links from the open node to the root (cycle-guarded, exactly like `resolveTalkRoot`); render `AURA` (non-clickable span) then each ancestor as a clickable crumb (`onNavigate(id)`) then the current label (non-clickable, bold). A node missing from the graph → just `AURA ▸ {headerLabel}`.
  - **Children strip:** `childrenOf(graph, sessionId)` → if non-empty, a horizontal list of small rows (hue dot + label + status pill) above the transcript; click → `onNavigate(child.id)`.
  - **Body:** `key={sessionId}` on the content wrapper so descend/ascend remounts with a `tdrawer-content-in` slide-fade animation.
  - Escape listener while open (`document.addEventListener("keydown", …)`); focus the panel element on open (`ref.current?.focus()`, `tabIndex={-1}`).
- [ ] **Step 4: Implement `thread-drawer.css`** — scrim fade (`opacity` `var(--motion-enter)`, `background: color-mix(in srgb, black 32%, transparent)`); panel `transform: translateX(100%)` ↔ `translateX(0)` with `transition: transform var(--motion-hero)`; glass background (`var(--bg)` body, blurred header); breadcrumb bar; children-strip rows with hover; `tdrawer-content-in` keyframe (opacity 0→1, translateX(12px)→0, `var(--motion-enter)`); reduced-motion = no transform transitions (opacity only).
- [ ] **Step 5: Swap in page.tsx** — replace `<SessionPeek sessionId={chatSessionId} open={!!chatSessionId} onClose={…} />` with:

```tsx
<ThreadDrawer
  sessionId={chatSessionId}
  onClose={() => setChatSessionId(null)}
  onNavigate={setChatSessionId}
/>
```

  Delete `session-peek.tsx`. `grep -rn "SessionPeek\|session-peek" packages/web/src` → no hits.
- [ ] **Step 6: Run** the talk suite + tsc.
- [ ] **Step 7: Commit** — `feat(talk): thread drawer — breadcrumbs, descend into nested sessions, conversation stays visible`

---

### Task 7: Motion & cohesion pass — pinned strip, banner, chips, staggers

**Files:**
- Modify: `packages/web/src/routes/talk/conversation-stream.css` (chip hover/press polish)
- Modify: `packages/web/src/routes/talk/talk-layout.css` (pinned row token alignment if any hardcoded px remain)
- Modify: `packages/web/src/routes/talk/attach-banner.tsx` + its styles (token alignment, enter/exit animation)
- Modify: `packages/web/src/routes/talk/cards/cards.css` (pinned deck entrance uses `--motion-enter` + stagger vars — keep current keyframes, only align durations/easings to tokens where they differ)

- [ ] **Step 1:** Audit the touched-by-this-round surfaces for motion inconsistencies: `grep -n "ms\b\|cubic-bezier" packages/web/src/routes/talk/conversation-stream.css packages/web/src/routes/talk/attach-banner.tsx packages/web/src/routes/talk/cards/cards.css | grep -v "var(--"` — list what's hardcoded.
- [ ] **Step 2:** Migrate those to the tokens (`--motion-enter`, `--motion-exit`, `--motion-hero`, `--ease-*`) WITHOUT changing the visual design intent (e.g. a 460ms spring entrance may stay a spring — wrap the duration/easing in tokens or leave a one-line comment where a token genuinely doesn't fit). Add hover (`translateY(-1px)` + border accent) and press (`scale(0.98)`) states to `.cstream__chip[data-clickable]`. Give the attach banner an enter/exit animation consistent with rows (opacity + translateY, `var(--motion-enter)`/`var(--motion-exit)`).
- [ ] **Step 3:** Reduced-motion check: every new animation/transition added this round is disabled or reduced under `@media (prefers-reduced-motion: reduce)` — `grep -n "prefers-reduced-motion" packages/web/src/routes/talk/*.css` and verify each new file (thread-card.css, work-tree.css, thread-drawer.css) has the block.
- [ ] **Step 4:** Run the full web suite + tsc + `npx vite build` (no `--force`).
- [ ] **Step 5: Commit** — `polish(talk): unified motion language — tokens, staggers, hover/press states`

---

### Task 8: Persona template — nested-delegation note

**Files:**
- Modify: `packages/cuttlefish/template/talk/orchestrator-persona.md`

- [ ] **Step 1:** Read the template's delegation section. Add a short paragraph (match the persona's existing voice/format):

```markdown
### Nested delegation
For multi-part work, tell the lead to split the work among its own sub-sessions
(spawn with `POST /api/sessions` + `parentSessionId` — every employee knows the
Child Session Protocol). The operator sees the whole tree live: each sub-thread
appears under your delegation card with its own status, so prefer one lead who
sub-delegates over three parallel threads you have to relay between yourself.
```

- [ ] **Step 2:** Verify no real names/PII added. Run cuttlefish tests touching the persona if any (`grep -rn "orchestrator-persona" packages/cuttlefish --include="*.test.ts"`).
- [ ] **Step 3: Commit** — `feat(talk): persona template — encourage nested delegation for multi-part work`

---

### Task 9: Gates

- [ ] **Step 1:** `cd packages/cuttlefish && npx vitest run` → all green.
- [ ] **Step 2:** `cd packages/web && npx vitest run` → all green.
- [ ] **Step 3:** `npx tsc --noEmit` in both packages; `cd packages/web && npx vite build` (NO `--force`); cuttlefish build (`npm run build` in packages/cuttlefish or the repo's build script).
- [ ] **Step 4:** `git status` clean except intended changes; commit anything pending.

---

## Verification after the plan (not subagent tasks)

Final whole-branch review, then browser E2E on an isolated gateway (mktemp CUTTLEFISH_HOME + port 7881; config needs `logging.level`, `connectors: {}`, `talk.orchestratorModel`; seed employees + a CLAUDE.md teaching the spawn protocol so a child can spawn a grandchild). Scenarios: centering assertion (stream column center within 8px of viewport center at 1280/1440), delegation ThreadCard lifecycle, NESTED delegation (grandchild appears in card + tree, drawer descends with breadcrumbs), drawer attach/engage, mobile 390×844, reduced-motion, zero console errors. Screenshots → attach to chat → report.
