# /talk Delegation & Work-UI Redesign — Design

**Date:** 2026-06-11
**Branch:** `talk-conversation-first` (continues on top of the stage redesign, HEAD d28e038)
**Status:** Approved by proxy — the operator reviewed the stage-redesign screenshots ("the direction is right"), gave this brief, and instructed full autonomous execution. Judgment calls are marked **[JUDGMENT]**.

## Operator brief (verbatim intent)

1. "The chat seems to be not centered… I like it horizontally centered on the screen."
2. "The UI elements, the delegation, the persistence and everything in between… revise them, make them way better. And way more interactive and nice to look at. Use fluid animations for all the transitions."
3. "For delegation, devise some work… so that it looks and feels like as if it is a real sort of a delegation communication. And one that the user can easily follow if they want and need to."
4. "Think about nested delegation. Try to make the child session spawn another child session. Think about how we will make that look. Think about how we can access those child sessions."

## Problem diagnosis (grounded in code)

1. **Off-center chat:** `.talk-main` is flex `stage + rail`; at ≥720px the WorkDock rail (`flex: 0 0 auto`) steals column width on the right, so the 640px transcript column centers in a *left-shifted* stage cell, not the viewport (`talk-layout.css:79-98`).
2. **Delegation doesn't read as communication:** the entire delegation story in the transcript is a one-line pill ("⟶ delegated → Platform Lead", `conversation-stream.tsx:77-93`). No brief, no live activity, no report content. The wealth of data the client *already receives* is discarded: `session:delta` events for every tree node (any depth) reach `use-talk.ts:656-659` and are used only to flip status to "running"; `session:completed` carries the child's final `result` text (`protocol.ts:66`) and is used only to flip status back.
3. **Nesting is invisible:** the backend fully supports arbitrary-depth trees — `buildGraphSnapshot()` BFS-walks all descendants, `talk:graph` events carry `depth`, completion wakes chain up parent links — but the UI flattens depth-2+ into ≤6 anonymous 7px "mini-dots" under a chip (`work-dock.tsx:125`, `work-dock-layout.ts`).
4. **Access is a dead-end modal:** session-peek is a centered modal that hides the conversation behind it, has no notion of where the session sits in the tree, and offers no way to descend into a sub-session.
5. **Motion is unfinished:** the stage round deliberately deferred enter/exit choreography; per-component timings are inconsistent (460/600/320/200ms mix). The operator has now explicitly asked for "fluid animations for all the transitions" — the deferred item is in scope.

## Requirements (derived; one per brief item)

- **R1 — Centered:** the conversation column is horizontally centered on the *viewport* at every width. No flow element may steal asymmetric column width.
- **R2 — Work UI quality:** the thread rail, pinned strip, banner, and chips share one visual + motion language (tokens), have hover/press states, and animate fluidly (springs, no teleporting).
- **R3 — Delegation as communication:** a delegation appears in the transcript as a *live thread card*: who → whom, what was asked (brief excerpt), what the worker is doing right now (live activity line), what came back (report excerpt). Followable at a glance without leaving the conversation.
- **R4 — Nested delegation:** when a child spawns its own child, the new worker appears (a) indented under its parent in the thread card and (b) in the tree rail — labeled, statused, clickable. Works to any depth. The E2E proves a real grandchild spawn.
- **R5 — Access:** any node in the tree opens in a side drawer (not a centered modal) with a breadcrumb path, a sub-thread list to descend, the full transcript, and attach/engage controls. The conversation stays visible behind it.

## Approaches considered

**A. Polish in place** — restyle chips/dock/modal, fix centering with an overlay rail. Cheap, but the delegation story stays a one-liner; fails R3/R4. Rejected.

**B. Conversation-first delegation (CHOSEN)** — the transcript remains the spine; delegation becomes a first-class *ThreadCard* row in the stream fed by the discarded delta/completed data; the rail becomes a floating *work tree* (real hierarchy, labels, live lines) that overlays the stage edge so the chat centers; peek becomes a slide-in *thread drawer* with breadcrumbs + descend navigation. Almost entirely client-side (one additive backend field). Fits the established design principles (transcript = spine, one focal point, morph don't teleport).

**C. Org-chart canvas** — a dedicated visual map page/overlay with orbiting nodes. Pretty but decorative: a second surface to maintain, duplicates the tree, and history shows the constellation was already removed in favor of denser UI. Rejected; the tree rail inherits its spirit (hue-coded nodes) in a readable form.

## The design

### 1. Centering (R1)

`.talk-rail` becomes an absolute overlay at **all** widths (the current <720px treatment universalized): `position:absolute; right:0; top:0; bottom:0; z-index:var(--z-rail); pointer-events:none` (children re-enable). The `@media (max-width:719px)` split is deleted. `.talk-stage` then spans the full main row and `.cstream__scroll` (max-width 640px, margin auto) centers on the viewport. The work tree auto-collapses to a slim dot rail when idle, so overlap with the transcript margin is rare and glassy when it happens.

### 2. ThreadCard — delegation as communication (R3, heart of the round)

A new stream row kind `thread` (component `thread-card.tsx`) replaces the `delegated` one-line chip (other chips — attached/detached/error/info — stay). One ThreadCard per depth-1 delegation, anchored at the point in the conversation where the delegation happened. Anatomy:

```
┌──────────────────────────────────────────────┐
│ ● AURA → Platform Lead            ⟳ working   │   header: hue dot, route, status pill
│ “Audit the funnel and split the fixes…”      │   brief excerpt (1-2 lines, quoted)
│ ⋯ reading repo · searching pricing page      │   LIVE activity line (ticker crossfade)
│   ↳ → Funnel Analyst        ⟳ working        │   nested sub-thread rows (indent + connector)
│      ⋯ querying PostHog                      │     each with own live line
│   ↳ → Pricing Reviewer      ✓ reported       │
│ ⟵ “Funnel audit done: 3 fixes shipped…”     │   report excerpt when completed
└──────────────────────────────────────────────┘
```

- **Data:** a new client-side **thread-activity store** (`thread-activity.ts`, plain reducer like graph-store) keyed by sessionId: `{ activity?: string, reportExcerpt?: string, briefExcerpt?: string }`. Fed from `use-talk.ts`: child `session:delta` `tool_use`/`text` → `activity` (reuse `whisperFor()` for tool deltas; first ~80 chars for text); child `session:completed` → `reportExcerpt` from `ev.result` (sanitized via `toSpeakable`-style stripping, ~140 chars). Graph store stays the structural source (nodes/status/labels).
- **Brief excerpt:** additive backend field `TalkGraphNode.briefExcerpt` (first ~140 chars of the session's prompt, set in `toGraphNode`) — works at every depth and survives reload via the snapshot. **[JUDGMENT** — server field over client fetch: one line of backend, no request fan-out on reload.**]**
- **Sub-rows:** `childrenOf(graph, node.id)` recursively (indent per depth, capped visual indent at 3 levels; deeper nests still listed, flat at max indent). Each sub-row: connector glyph `↳`, route `→ label`, status pill, own live activity line. Appearing rows animate in (grid `0fr→1fr` height expansion + fade — the card grows fluidly, nothing jumps).
- **Status pill:** working (pulse) / waiting / reported ✓ / error ⚠; crossfades on change.
- **Interactions:** click header or any sub-row → opens the thread drawer for that node. Hover lift (as cards). When the thread completes, the card settles (live line fades out, report line fades in, pulse stops, slight dim).
- The `reported` one-line chip is **removed** (the card's report line replaces it).

### 3. Work tree rail — the redesigned WorkDock (R2, R4)

`work-tree.tsx` (+`work-tree.css`) replaces `work-dock.tsx`'s chip+mini-dot rendering, keeping the proven store/menu/rename/pin logic. A floating glass panel anchored right, vertically centered:

- **Collapsed (idle, default):** a slim vertical stack of hue dots — one per depth-1 thread, nested descendants as smaller dots tucked beside their parent dot. Pure presence indicator.
- **Expanded (hover, focus-within, or anything working):** a real tree — each node a row with hue dot, label, status, and (working nodes only) the live activity line from the thread-activity store; depth-2+ rows indent under a hairline connector. Rows are clickable (drawer), renameable (depth-1, kept), pinnable as route target (kept), dismissable (kept).
- **Transitions:** expand/collapse animates width+opacity with the `snappy` spring timing; row enter/exit use shared enter/exit tokens; working dots keep the pulse.
- Mini-dots, `wd-*` classes and `work-dock-layout.ts` frontier-walk die; `childrenOf` recursion replaces them.

### 4. Thread drawer — access (R5)

`thread-drawer.tsx` replaces session-peek's centered modal with a right-edge slide-in panel (width `min(480px, 92vw)`, height 100dvh, `--z-overlay`):

- **Breadcrumb header:** the path from root, e.g. `AURA ▸ Platform Lead ▸ Funnel Analyst` — each crumb clickable to navigate up. Built from graph `parentId` links.
- **Sub-threads strip:** children of the open session as small rows (hue, label, status) — click to descend. Appears only when children exist.
- **Transcript:** reuse `<ChatMessages>` exactly as session-peek does today (live streaming included).
- **Attach/engage controls + engage composer:** carried over unchanged.
- **Motion:** slides in/out with the `stage` spring; scrim fades; the talk stage dims slightly behind it. In-drawer navigation (descend/ascend) crossfades + slides the content horizontally (`enter`/`exit` tokens). Escape / scrim click closes.
- session-peek.tsx is deleted; all open-thread paths (stream chips, ThreadCard, work tree, search sheet) route to the drawer.

### 5. Motion pass — "fluid animations for all the transitions" (R2)

The deferred stagger choreography lands now, scoped to the talk page:

- All touched components consume the motion tokens (`--motion-enter/exit/hero`) and spring presets; no new hardcoded durations in touched files.
- Entering content (rows, cards, tree rows, drawer) uses enter timing with small staggers; exiting uses exit timing. Height growth (ThreadCard sub-rows, banner, pinned) animates via grid-row `0fr→1fr` transitions, never `display` snaps.
- Pinned strip + attach banner restyle to the shared language (glass, radius, tokens) — visual unification, not structural change.
- `prefers-reduced-motion`: every new animation has a fade/snap fallback (existing pattern).

### 6. Nested delegation enablement (R4)

- **Persona template** (`packages/cuttlefish/template/talk/orchestrator-persona.md`): add a short "nested delegation" note — for multi-part work, instruct the lead to split the work among its own sub-sessions (the Child Session Protocol in the gateway CLAUDE.md already teaches spawned employees how); mention sub-threads are visible to the operator live. **[JUDGMENT** — encourage, don't force; the orchestrator decides when nesting helps.**]**
- **No delegate-endpoint changes:** the orchestrator continues to manage only its direct children (roster/continue); grandchildren are *visible* (graph) and *accessible* (drawer, attach) — that matches the org model (managers manage their reports). Documented as an explicit non-goal this round.
- **E2E:** the isolated CUTTLEFISH_HOME gets a CLAUDE.md teaching the spawn protocol + 2 employee personas; the scenario asks AURA for a task that names two specialists under a lead; PASS = a depth-2 node appears in the ThreadCard sub-rows + work tree, and the drawer descends to it with breadcrumbs.

### 7. What does NOT change

Backend delegate/attach endpoints, callbacks, graph BFS/events (except the additive `briefExcerpt`), card system data contracts, use-conversation reducer core, audio/TTS, stage machine, orb layer. `talk:focus` stays direct-children-only.

### 8. Testing

- thread-activity store: pure reducer tests (delta→activity, completed→excerpt, sanitization, cap).
- ThreadCard: render tests — header route, brief, live line, nested sub-rows from a depth-3 graph fixture, report state.
- Work tree: depth rendering, collapse/expand state, click routing (replaces work-dock tests; rename/pin/dismiss behavior preserved).
- Drawer: breadcrumb path from graph links, descend/ascend navigation, attach controls intact (port session-peek tests).
- `briefExcerpt`: graph unit test (truncation, presence at depth 2).
- Browser E2E on an isolated gateway: re-run prior scenarios + new nested-delegation scenario + centering assertion (transcript column centered within 8px of viewport center at 1280 and 1440 widths) + zero console errors. Fresh screenshots for operator.

## Error handling

Thread-activity store is advisory overlay data — missing entries render nothing (card shows structure without live lines). Graph remains the single structural source; a ThreadCard whose node vanishes (dismissed) settles to its last known state and stops subscribing. Drawer navigation to a deleted session falls back to the messages-API error state (exists today). Excerpt sanitization failures degrade to omitting the excerpt, never to raw UUID/markdown soup.

## Post-review deviations

- **Sub-row entrance animation:** ThreadCard sub-rows enter with a translateY+fade instead of the specced grid `0fr→1fr` height expansion — simpler, and visually equivalent at the one-row scale a delegation typically adds.
- **`activityFor` instead of reusing `whisperFor`:** child "now doing" lines come from a new child-scoped mapper (`thread-activity.ts`). The orchestrator whisper phrasing (routing…/preparing a card…) didn't fit worker sessions, so the two vocabularies stay separate.
- **Delegation cards are rebuilt from the graph snapshot on reload:** live cards insert on the `talk:graph` "added" delta, which rehydration can't replay. On (re)connect, `snapshotDelegationChips` maps depth-1 owned snapshot nodes back to their stable `sys-del-<id>` rows after the transcript rehydrate — the original live insertion order is approximated by appending after history (the reducer dedups by id, so reconnects are no-ops).
- **ThreadDrawer ✕ close button:** the drawer has an explicit close button beyond the specced Escape/scrim-click paths — mobile reachability (the scrim sliver is thin on narrow viewports).
