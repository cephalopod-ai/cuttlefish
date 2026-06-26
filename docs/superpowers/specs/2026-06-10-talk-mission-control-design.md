# Cuttlefish Talk — "Mission Control" Redesign

**Date:** 2026-06-10 · **Branch:** `talk-mission-control` · **Status:** Approved direction (operator-approved, 2026-06-10)

## Problem

/talk today is prompt-orchestrated end to end, which makes it fragile and uninformative:

1. **Delegation misroutes.** AURA spawns/continues COO sessions by hand-writing `curl` from prose persona instructions (`orchestrator-persona.md`). Nothing injects the live thread roster into its context, and the default model is haiku (`talk/routes.ts:33`), so "spawn a new thread" frequently reuses or visually replaces an existing one.
2. **The picture disappears.** The constellation shows one level (AURA → COO) only; satellites *hide* 4.5s after a turn ends (thread-store "park"), and COO→employee grandchildren are never shown. The user cannot see what the org is doing at a glance.
3. **No rich output.** The transcript shows only the latest sentence and *replaces* it per sentence; markdown/links are stripped; the card validator (`card-validate.ts`) rejects 8 of the 13 card types the frontend can already render (incl. `link`), while the live persona still instructs AURA to push 3 of the rejected types (drift).
4. **Dead air.** Server TTS synthesizes the whole reply once at turn end (`tts-stream.ts`), so the user watches "thinking" through the entire generation before audio starts.

## Goal

Make /talk a credible *primary* interface to the gateway: structured, server-owned orchestration; a live, persistent, multi-level session graph as the centerpiece; richer cards; readable history; lower voice latency.

## Design

### 1. Server-side delegation endpoint — `POST /api/talk/delegate`

New route in `talk/routes.ts`. One endpoint owns spawn-vs-continue:

```json
{ "sessionId": "<talk-session-id>", "thread": "new" | "<coo-session-id>",
  "label": "Content pipeline", "brief": "<expanded brief>" }
```

- `thread: "new"` → creates a COO child (`parentSessionId = sessionId`, no employee, default engine), sets `title = label`, returns `{ threadId, created: true }`.
- `thread: "<id>"` → validates the id is a *live child of this talk session*; posts the brief as a follow-up message. Unknown/foreign id → `400` with the valid roster in the error body (self-correcting for the model).
- Internally reuses the existing session-creation/message paths so `talk:focus`, parent callbacks, and queueing behave exactly as today.
- Works identically on every engine (claude/codex/antigravity/pi) because it is just HTTP — no MCP server, no engine-specific tool wiring.

### 2. Thread-roster injection (context)

In `buildContext()` (`sessions/context.ts`, called from `api.ts:2176` for `source === "talk"`), inject a compact ESSENTIAL section next to the persona, rebuilt every turn:

```
## Your open COO threads
- a3f9c2 "Content pipeline" — running, last activity 2m ago
- 7b14e0 "Platform order" — idle, last activity 1h ago
(use POST /api/talk/delegate with thread:"<id>" to continue one, thread:"new" for a new topic)
```

Source: `listChildSessions(talkSessionId)`, newest first, capped (~12).

### 3. TalkGraph — server-authoritative session tree

New module `talk/graph.ts`:

- **Membership:** a session belongs to the talk graph if walking `parentSessionId` reaches a `source === "talk"` root (registry lookups; depth is small, cache the resolution per sessionId).
- **Snapshot:** `GET /api/talk/graph?root=<talkSessionId>` → `{ nodes: [{ id, parentId, depth, label, employee, status, lastActivity, totalTurns }] }`, built by recursive `listChildSessions`.
- **Deltas:** emit `talk:graph` WS events from the existing lifecycle hooks in `api.ts` (where `session:started/completed/updated` are emitted) whenever the session is in a talk subtree: payload `{ rootId, node: {…}, change: "added" | "status" | "completed" | "removed" }`. This makes COO→employee grandchildren (any depth) visible live — including spawns the talk UI currently never hears about.
- **Auto-cards are dropped** (consolidation of the original item 3): the graph itself is the WATCH surface; `status` / `agent-activity` cards remain available but model-authored only. Rationale: avoid two competing renderings of the same activity.

### 4. Frontend — constellation becomes the graph

- New `graph-store.ts` (reducer like `thread-store.ts`): hydrate from `GET /api/talk/graph`, apply `talk:graph` deltas. `thread-panel` and `constellation` both read from it (thread chips = depth-1 nodes; keep rename/dismiss).
- `constellation.tsx` renders **all depths**: depth-1 COO orbs in the existing row; depth-2+ as smaller satellite dots clustered under their parent with the same SVG tether treatment (flow while `running`).
- **Never auto-hide:** replace the 4.5s park-and-vanish with a *dimmed idle* visual (reduced opacity/scale, no equalizer/flow animation). Nodes leave only on user dismiss (or session delete). Cap rendered nodes (~24, newest-active first) with a "+N more" affordance to protect the layout.
- Click any node at any depth → existing `child-session-modal` (it already takes any sessionId).

### 5. Cards — widen the validator, fix the drift

- `card-validate.ts` accepts **all 13 types** the renderer supports (`text, stat, list, image, image-grid, status, agent-activity, link, choice, approval, comparison, keyvalue, diff`). Taste (DO/WATCH-first, 1–2 cards) moves entirely to the persona, where it belongs.
- `link` becomes the canonical answer to "give me a link" — persona explicitly: never speak a URL, always card it.
- Frontend `MAX_CARDS` 4 → 6 (graph absorbs the WATCH load).

### 6. Transcript — history + links

- Keep the cinematic big-caption as-is, but stop discarding: accumulate exchanges in state and add a collapsible, scrollable **history rail** (reuses talk styling, not the chat renderer).
- In history (and the current caption), linkify bare URLs / markdown links into tappable anchors; everything else stays plain text. TTS path still receives the stripped text.

### 7. TTS — per-sentence streaming

- `feedTalkText()` detects sentence boundaries as deltas arrive and synthesizes each completed sentence immediately; `flushTalkSpeech()` only speaks the remainder.
- Contract fix required: `kokoro.speak()` resets `seq` to 0 and emits `last:true` per call. Change to a per-turn monotonic `seq` (passed in or managed by tts-stream) and emit `last:true` only on the final flush, so multi-call turns don't collide or prematurely end audio. Frontend audio-player already orders by `seq`.

### 8. Model + persona

- `DEFAULT_TALK_MODEL` haiku → **sonnet** (`talk/routes.ts:33`).
- Rewrite `DEFAULT_ORCHESTRATOR_PERSONA` + `template/talk/orchestrator-persona.md`: delegate via `/api/talk/delegate` only (no raw `/api/sessions` curl), roster-aware reuse/new rules, link-card rule, updated card catalogue. **Do not modify the live `~/.cuttlefish/talk/orchestrator-persona.md` during development** (hot-reloads into the production 8888 gateway); replacing it is a deploy step.

## Error handling

- `/api/talk/delegate` validates sessionId is a talk session, thread id is its child, brief non-empty; errors return actionable JSON (`error` + `threads` roster).
- Graph walk guards against parent cycles (visited set) and missing parents (orphan → not in graph).
- `talk:graph` emission is best-effort; snapshot endpoint is the source of truth on (re)connect.
- TTS sentence splitter falls back to turn-end flush on any error (current behavior preserved).

## Testing

- **Unit (vitest):** graph membership/snapshot/delta logic; delegate endpoint (new/continue/bad-id); card validator widening; sentence-boundary splitter + seq contract; roster section rendering; frontend graph-store reducer; constellation depth layout helpers; linkify.
- **Integration:** isolated gateway — worktree build, `CUTTLEFISH_HOME=/tmp/cuttlefish-mc-test`, port **7878** (live 8888 untouched). Script: create talk session → delegate two threads → spawn a grandchild under one COO → assert `GET /api/talk/graph` shape and WS `talk:graph` events.
- **Browser:** Chrome against `http://localhost:7878/talk` — type-to-talk a delegation, verify roster-driven reuse, multi-level constellation rendering, dimmed-idle (no vanish), link card tap, history rail.

## Out of scope

Generative-UI `view` card (Approach B — later, on top of this), VAD/hands-free, Kokoro voice quality, /chat surface changes, deploying to the live 8888 gateway (the operator triggers restart + live persona swap).
