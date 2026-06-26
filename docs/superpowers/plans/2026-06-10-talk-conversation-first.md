# Talk "Conversation-First Mission Control" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three live-tested /talk bugs (audio dies after turn 1; IDs/markdown spoken literally; no visible delegation) and rebuild /talk into a conversation-first surface where the orchestrator can search ANY past session, attach to it, and send enriched requests in the operator's name.

**Architecture:** Backend: a deterministic speech sanitizer inside the TTS stream, serialized per-turn TTS chains, FTS5 full-text search over `messages` (FTS5 verified compiled into our better-sqlite3), an attachment registry letting a talk session adopt arbitrary sessions as graph members + wake targets, and `/api/talk/delegate` extended with `attach`/`detach`/`mode`/`utterance`. Frontend: the replace-per-sentence caption + hidden history rail + constellation row + thread panel are replaced by a persistent **ConversationStream** (accumulating rows, karaoke sentence highlight, inline system chips for delegation lifecycle, inline cards) and a right-edge **WorkDock** driven solely by `graph-store`, plus a **SessionSearchSheet** and an upgraded **SessionPeek** with attach controls.

**Tech Stack:** TypeScript, Fastify-style route handlers (existing patterns in `talk/routes.ts`), better-sqlite3 FTS5, React 18 (packages/web — NO semicolons), vitest both packages.

**Repo:** worktree `<worktree>`, branch `talk-conversation-first`. Backend code uses semicolons; web code does not. Run backend tests with `pnpm --filter cuttlefish-cli test -- <file>` and web tests with `pnpm --filter @cuttlefish/web test -- <file>` from the worktree root. NEVER touch `~/Projects/cuttlefish` (live gateway) or `~/.cuttlefish/talk/*` (live persona). No Co-Authored-By lines in commits.

**Analysis references (read if you need context):** `docs/superpowers/specs/2026-06-10-talk-mission-control-design.md` (previous round). Root causes this round: (1) `tts-stream.ts` `flushTalkSpeech` deletes turn state before awaiting the synth chain → consecutive turns interleave, frontend `last:true` handling kills turn-2 audio; (2) zero server-side text sanitization before Kokoro + `callbacks.ts` wake message injects raw UUIDs into the model's context; (3) graph plumbing works but the persona never delegates, and delegation is invisible in the transcript.

---

## Phase 1 — Fluency must-fixes

### Task 1: Serialize per-turn TTS chains + fix the audio-death race

**Files:**
- Modify: `packages/cuttlefish/src/talk/tts-stream.ts`
- Modify: `packages/web/src/routes/talk/audio-player.ts` (stale contract comment + turn-boundary reset)
- Test: `packages/cuttlefish/src/talk/__tests__/tts-stream.test.ts` (extend)
- Test: `packages/web/src/routes/talk/__tests__/audio-player.test.ts` (extend if exists, else create)

**Contract to establish (backend):** all `talk:speak`/audio events for turn N (including its `last:true`) are emitted strictly before any event for turn N+1. Implementation:

- [ ] **Step 1: Write the failing backend test.** In `tts-stream.test.ts`, using the existing `__setTalkTtsForTest` seam, install a fake `speak` whose first call resolves after 50ms and records `(text, opts)` + a completion timestamp. Drive: `feedTalkText(s, "First sentence. ", …)` → `flushTalkSpeech(s, …)` (do NOT await) → immediately `feedTalkText(s, "Second sentence. ", …)` → `await flushTalkSpeech(s, …)`. Assert: (a) the recorded call order is `["First sentence.", "Second sentence."]` and the second call STARTS after the first RESOLVES; (b) the first turn's call got `final: true` before the second turn's first call started; (c) after both flushes, internal state is empty (export or test via a second feed working normally).
- [ ] **Step 2: Run it, verify it fails** (today turn 2's chain starts while turn 1's synth is pending). `pnpm --filter cuttlefish-cli test -- tts-stream`
- [ ] **Step 3: Fix.** In `tts-stream.ts`: keep a per-session `tail: Promise<void>` map (module-level, alongside `turns`). `getTurn` for a NEW turn chains its work after the previous tail. Concretely: when `queueSentence` builds the chain, the first link awaits the previous session tail; `flushTalkSpeech` becomes: capture `t`, queue the remainder, set `tail = t.chain`, `await t.chain`, then `if (turns.get(sessionId) === t) turns.delete(sessionId)` (never delete a successor's state). Keep epoch-discard semantics for interrupts intact.
- [ ] **Step 4: Run the full tts-stream + kokoro test files, verify green.**
- [ ] **Step 5: Frontend audit + fix.** Read `audio-player.ts` and `use-speak.ts`. Fix the stale header comment (seq is per-turn monotonic from `seqStart`, `last:true` only on final flush). Ensure: when a chunk arrives after a `last:true` (new turn), the player fully re-arms (resets any "stream ended" latch, resumes a suspended AudioContext before enqueue — `if (ctx.state === "suspended") await ctx.resume()` in `enqueue`, not just fire-and-forget void). Add/extend a frontend test: feed chunk(seq 0)+last:false, chunk(seq 1, last:true), then NEW turn chunk(seq 0) — assert the third chunk is scheduled for playback (player not stuck).
- [ ] **Step 6: Run web tests for the talk route, verify green.** `pnpm --filter @cuttlefish/web test -- talk`
- [ ] **Step 7: Commit.** `fix(talk): serialize per-turn TTS chains; re-arm audio player across turns`

### Task 2: Server-side speech sanitizer (`toSpeakable`)

**Files:**
- Create: `packages/cuttlefish/src/talk/speakable.ts`
- Modify: `packages/cuttlefish/src/talk/tts-stream.ts` (apply in `queueSentence` on the extracted sentence and on the flush remainder — NOT on raw deltas, since markdown tokens split across delta chunks)
- Test: `packages/cuttlefish/src/talk/__tests__/speakable.test.ts`

- [ ] **Step 1: Write failing tests** for `toSpeakable(text: string): string`:
  - `**Bold claim** stands` → `Bold claim stands`
  - `*em* and _under_ and \`code\`` → `em and under and code`
  - `# Heading\n- bullet one` → `Heading. bullet one` (heading/bullet markers dropped, sentence-safe)
  - `see [the doc](https://x.y/z)` → `see the doc`
  - `open https://example.com/path?q=1 now` → `open the link on screen now`
  - `session 94f97239-b6ab-4101-8e37-48814246d7c1 done` → `session done` → then whitespace-collapsed: `session done`
  - `ok [card-action card=x action=approve] done` → `ok done`
  - code fence block ` ```js\ncode\n``` ` → `` (empty → caller skips speak)
  - plain conversational text passes through byte-identical.
- [ ] **Step 2: Run, verify fail.** `pnpm --filter cuttlefish-cli test -- speakable`
- [ ] **Step 3: Implement.** Port the stripping logic from `packages/web/src/lib/strip-markdown.ts` (keep web copy untouched), then add: URL → `the link on screen` (regex `https?:\/\/\S+`), UUID v4-ish (`/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi`) and bare hex ≥12 chars → removed, machine tags (`/\[(card-action|Route this)[^\]]*\]/g`) → removed, fenced code blocks → removed, collapse runs of spaces, trim. Export `toSpeakable`.
- [ ] **Step 4: Wire into `tts-stream.ts`:** sanitize each extracted sentence and the flush remainder; if the result is empty/whitespace, skip the `speak` call entirely (do not bump seq). Add a tts-stream test: feeding `"**Done.** "` results in a speak call with `"Done."`; feeding a sentence that sanitizes to empty results in zero speak calls.
- [ ] **Step 5: Run both test files green, commit.** `feat(talk): sanitize speech server-side (markdown/URLs/UUIDs/machine tags)`

### Task 3: Talk-tailored parent wake message (no raw IDs in the stimulus)

**Files:**
- Modify: `packages/cuttlefish/src/sessions/callbacks.ts` (the `📩` message builder)
- Test: `packages/cuttlefish/src/sessions/__tests__/callbacks.test.ts` (extend existing test file for callbacks; create if absent)

- [ ] **Step 1: Failing test:** when the PARENT session has `source: "talk"`, the engine-facing `message` must (a) contain the child's label (title, else employee name, else `"a thread"`), (b) contain the reply preview, (c) NOT contain the child session id, (d) NOT contain `GET /api/sessions`, (e) contain the narration instruction. Expected shape:
  ```
  📩 Thread "<label>" reported back.

  Reply preview:
  <preview>

  Narrate the outcome aloud in 1–2 short sentences — no IDs, no URLs, no markdown. If there is a link or detail worth seeing, push a card. To follow up, delegate to this thread via /api/talk/delegate (its id is in your roster).
  ```
  Non-talk parents keep the existing message byte-identical (regression assertion).
- [ ] **Step 2: Run, verify fail. Step 3: Implement** (branch on parent source in the builder; reuse existing preview truncation). **Step 4: green. Step 5: Commit** `fix(talk): label-based wake message for talk parents`

### Task 4: Delegation history survives reload (notification rows in rehydrate)

**Files:**
- Modify: `packages/web/src/routes/talk/rehydrate.ts` (stop dropping `role:"notification"`)
- Modify: `packages/web/src/routes/talk/types.ts` (entry kind)
- Test: `packages/web/src/routes/talk/__tests__/rehydrate.test.ts`

- [ ] **Step 1: Failing test:** `messagesToEntries` maps a `{role:"notification", content:"📩 Thread \"Content blog\" reported back. …"}` message to `{ kind: "system", event: "reported", label: "Content blog" }` (label parsed from the quoted segment; unparsable notification → `{kind:"system", event:"info", label: first 60 chars}`). User/assistant mapping unchanged.
- [ ] **Step 2-4: red → implement → green.** Keep the entry type additions minimal — Task 9 consumes them.
- [ ] **Step 5: Commit** `feat(talk): keep notification rows on rehydrate as system entries`

## Phase 2 — Search + attach backend

### Task 5: FTS5 message search in the registry

**Files:**
- Modify: `packages/cuttlefish/src/sessions/registry.ts`
- Test: `packages/cuttlefish/src/sessions/__tests__/registry.test.ts` (extend)

- [ ] **Step 1: Failing tests** for `searchMessages(query: string, limit?: number)`:
  - insert sessions + messages (roles user/assistant/notification/tool), search a word present in an assistant message → returns `[{ sessionId, snippet, role, timestamp }]` with `«»` highlight markers in snippet;
  - notification/tool rows are NOT indexed (search a word only present there → empty);
  - multi-word query matches AND-ish (both words), special chars (`"fix-up (urgent)"`, quotes, `*`) do NOT throw (sanitize by wrapping each whitespace-token in double quotes with internal `"` stripped);
  - results grouped newest-first, capped by limit.
- [ ] **Step 2: Run, fail. Step 3: Implement.** Migration in the existing migration mechanism of `registry.ts`:
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61');
  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages WHEN new.role IN ('user','assistant') BEGIN INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages WHEN old.role IN ('user','assistant') BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content); END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages WHEN new.role IN ('user','assistant') BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content); INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); END;
  ```
  Backfill: chunked (1000 rows/transaction) `INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages WHERE role IN ('user','assistant') AND rowid > ?` driven off the request path via `setImmediate` loop, guarded by a `meta` flag (`fts_backfill_done`) so it runs once; follow the existing `scheduleTranscriptBackfill` pattern in the file. Query: `SELECT m.session_id as sessionId, snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet, m.role, m.timestamp FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ? ORDER BY m.timestamp DESC LIMIT ?`.
- [ ] **Step 4: green. Step 5: Commit** `feat(sessions): FTS5 full-text search over messages with chunked backfill`

### Task 6: `GET /api/talk/search`

**Files:**
- Create: `packages/cuttlefish/src/talk/search.ts`
- Modify: `packages/cuttlefish/src/talk/routes.ts`
- Test: `packages/cuttlefish/src/talk/__tests__/search.test.ts`

- [ ] **Step 1: Failing tests** for `searchTalkSessions(q, deps)` (deps injectable: `searchSessions`, `searchMessages`, `getSession`): merges title hits + content hits, de-dupes by sessionId (title hit wins position, content hits attach as `hits[]`), response per result `{ sessionId, title, employee, source, lastActivity, status, isTalkChild, hits: [{snippet, role, ts}] }` capped 20; empty q → `{ok:false,status:400}`.
- [ ] **Step 2-3: red → implement** + route `GET /api/talk/search?q=&limit=` in `routes.ts` following the existing route style (the graph route is the model). **Step 4: green. Step 5: Commit** `feat(talk): /api/talk/search merging title + FTS content hits`

### Task 7: Attachments + delegate `attach`/`detach`/`mode`/`utterance`

**Files:**
- Create: `packages/cuttlefish/src/talk/attachments.ts`
- Modify: `packages/cuttlefish/src/talk/delegate.ts`
- Modify: `packages/cuttlefish/src/talk/routes.ts` (pass new deps)
- Test: `packages/cuttlefish/src/talk/__tests__/attachments.test.ts`, extend `__tests__/delegate.test.ts`

**attachments.ts API:** `attach(talkId, targetId, mode)`, `detach(talkId, targetId)`, `listAttachments(talkId): {targetId, mode, since}[]`, `talkSessionsAttachedTo(targetId): string[]`, persisted by merging into the talk session's existing `transport_meta` JSON column (key `talkAttachments`) via injected `getSession`/`updateSessionMeta` deps; in-memory map hydrated lazily from meta. Cap 5 per talk session (`attach` returns `{ok:false, error}` at cap).

**delegate.ts new body fields:** `attach?: boolean`, `detach?: boolean`, `mode?: "observe"|"engage"` (default observe), `utterance?: string`.
- `detach:true` → validate attachment exists, remove, return `{ok:true, threadId, detached:true}`. No message sent.
- `attach:true` → target must exist, must NOT be a talk session, must not already be attached; skip the parent-ownership check; register; if `mode:"engage"` AND `brief` present, post follow-up message composed as:
  ```
  [Relayed by AURA on behalf of the operator]

  <brief>

  ---
  Operator's original request (verbatim): "<utterance>"
  If the brief above misreads this, the original words win.
  ```
  (the provenance prefix is added in code, unconditionally). `mode:"observe"` with a brief → `{ok:false,status:400,error:"observe mode cannot send messages — attach with mode \"engage\""}`.
- Plain `thread:"new"`/`thread:"<child-id>"` delegations: when `utterance` is present, compose the child prompt with the same `---`/verbatim block appended after the brief. `utterance` is OPTIONAL (back-compat: existing smoke script body must keep working).

- [ ] **Step 1: Failing tests** covering every branch above (incl. cap, talk-target rejection, double-attach rejection, provenance prefix presence, observe+brief 400, utterance composition for both delegate and engage paths, detach unknown → 400 with attachments roster in error).
- [ ] **Step 2-4: red → implement → green.** **Step 5: Commit** `feat(talk): attachments + delegate attach/detach/mode/utterance with enforced provenance`

### Task 8: Attachment-aware graph + completion wake for attached sessions

**Files:**
- Modify: `packages/cuttlefish/src/talk/graph.ts` (`TalkGraphNode` gains `attached?: true; mode?: "observe"|"engage"`; `resolveTalkRoot` ALSO checks `talkSessionsAttachedTo(sessionId)`; `buildGraphSnapshot` appends attachment nodes at depth 1; new change kinds `"attached"|"detached"` emitted from delegate via a new exported `emitAttachmentChange`)
- Modify: `packages/cuttlefish/src/talk/delegate.ts` (emit attached/detached deltas)
- Modify: `packages/cuttlefish/src/sessions/callbacks.ts` (after the parent notify, also wake every talk session in `talkSessionsAttachedTo(completedSessionId)` with the Task-3-style talk message — label = the attached session's title/employee)
- Modify: `packages/web/src/routes/talk/graph-store.ts` + `packages/web/src/routes/talk/protocol.ts` (accept `attached`/`mode` on nodes; `attached`/`detached` change kinds map to upsert/remove)
- Test: extend `__tests__/graph.test.ts`, `__tests__/callbacks.test.ts`, web `__tests__/graph-store.test.ts`

- [ ] **Step 1: Failing tests:** (a) snapshot for a talk root with one child + one attachment returns the attachment node `{depth:1, attached:true, mode}`; (b) a status change on an ATTACHED session (not a descendant) emits `talk:graph` with that root; (c) completion of an attached session triggers the talk wake message even though its parent is elsewhere; (d) web graph-store upserts `attached` nodes and removes on `detached`.
- [ ] **Step 2-4: red → implement → green.** Wake plumbing: do it inside `callbacks.ts`'s completion notify path (single choke point) — verify by grep that BOTH `gateway/api.ts` and `sessions/manager.ts` completion sites route through it; if one bypasses, add the call there too (the duplicated-notify-site trap is known).
- [ ] **Step 5: Commit** `feat(talk): attachments join the graph and wake the talk session on completion`

## Phase 3 — UI redesign

**Shared rules for all Phase-3 tasks:** packages/web has NO semicolons; reuse existing CSS custom properties from `talk`-scoped stylesheets; everything must work in BOTH themes; the stream overlay keeps the `pointer-events: none` + re-enabled interactive children pattern; all new pure logic in plain `.ts` files with unit tests, components thin.

### Task 9: ConversationStream replaces transcript + history rail

**Files:**
- Create: `packages/web/src/routes/talk/use-conversation.ts` (pure reducer + hook), `packages/web/src/routes/talk/conversation-stream.tsx`, `packages/web/src/routes/talk/conversation-stream.css`
- Modify: `packages/web/src/routes/talk/use-talk.ts` (feed the reducer: user finalized text → user row; assistant deltas → `appendAssistantText` accumulating ALL sentences; sentence-spoken callback moves `liveIdx`; `talk:graph change:"added"` → system chip `delegated`; notification entries from Task 4 → `reported` chips), `page.tsx` (mount stream, remove `<Transcript/>` + history rail button)
- Delete: `packages/web/src/routes/talk/history-rail.tsx`, usages of `transcript.tsx` (keep `WordReveal` by moving it into `conversation-stream.tsx` if reused; delete `transcript.tsx` once nothing imports it)
- Test: `packages/web/src/routes/talk/__tests__/use-conversation.test.ts` (reducer), extend `__tests__/use-talk.test.ts` snapshot-ish assertions if present

**Row model:**
```ts
export type StreamRow =
  | { kind: "user"; id: string; text: string; pending?: boolean }
  | { kind: "aura"; id: string; sentences: string[]; liveIdx: number | null; partial: boolean }
  | { kind: "system"; id: string; event: "delegated" | "reported" | "attached" | "detached" | "error" | "info"; threadId?: string; label: string; hue?: number; ts: number }
```

**Render contract:** rows grouped with a tiny speaker eyebrow ("you" / "AURA" / hue-dot+label for system chips); in an `aura` row, sentences < liveIdx render full-opacity, sentence === liveIdx gets the highlight treatment (reuse WordReveal blur-in + accent underline), sentences > liveIdx render at ~0.35 opacity; URLs through the existing `Linkified`; auto-scroll pinned to bottom unless the user scrolled up (then a "jump to live" pill); at `idle` state the whole stream dims to 0.6 and the last ~3 turns stay visible; stream itself `pointer-events:none`, links/chips re-enable.

- [ ] **Step 1: Failing reducer tests:** append user row; stream assistant text in 3 delta chunks forming 2 sentences → one `aura` row, `sentences.length===2`, `partial:true`; `markSpoken(rowId, idx)` moves liveIdx; finalize sets `partial:false, liveIdx:null`; `addSystem({event:"delegated"...})` inserts chip BEFORE the in-progress aura row if one is partial (chips narrate what just happened, ordering matters); cap total rows at 200 dropping oldest.
- [ ] **Step 2-3: red → implement reducer → green. Step 4: build the component + CSS** (no unit test for pixels; Phase-5 browser pass covers it). Wire `use-talk.ts`. Keep `splitSentences` from the existing code path. **Step 5: full web suite green** (`pnpm --filter @cuttlefish/web test`), fix any import fallout from deleted files. **Step 6: Commit** `feat(talk): ConversationStream — persistent karaoke transcript with delegation chips`

### Task 10: WorkDock replaces constellation row + thread panel (single graph source)

**Files:**
- Create: `packages/web/src/routes/talk/work-dock.tsx`, `work-dock.css`, `packages/web/src/routes/talk/work-dock-layout.ts` (pure: ordering working-first newest-first, depth-2 mini-dot frontier — port from `constellation-layout.ts`)
- Modify: `packages/web/src/routes/talk/use-talk.ts` (drop `thread-store` entirely; port hue assignment (`channel-identity.ts`), label overrides, dismiss tombstones, and the route-target pin onto graph nodes / a small `Map<string, {hue, labelOverride, pinned}>` side-state), `page.tsx`, `aura-avatar` focus wiring (orb hue morph now driven by the focused/most-recent working dock node)
- Delete: `packages/web/src/routes/talk/thread-panel.tsx`, `thread-panel.css`, `thread-store.ts`, `constellation.tsx`, `constellation.css`, `constellation-layout.ts`, `task-tracker.tsx`, `tracker.css` (dead code) — after migrating what's reused
- Test: `packages/web/src/routes/talk/__tests__/work-dock-layout.test.ts` (port + extend constellation-layout tests), delete superseded thread-store/constellation tests

**Render contract:** vertical rail on the right edge; one chip per depth-1 node: hue dot (solid = owned child, dashed/hollow ring + `⇄` = attached), label, status glyph (`▸ running` pulse / `✓ done` dim / `✗ error`), up to 6 mini-dots for depth-2 descendants; tap chip → SessionPeek; long-press/context → rename, dismiss, pin-as-route-target (ports ThreadPanel's three controls); collapsed to edge dots when idle, expands on hover/touch or when anything is `running`.

- [ ] **Step 1: Failing layout tests** (ordering: working first then newest; attached nodes sort after owned working nodes but before idle; mini-dot frontier walk; overflow "+N").
- [ ] **Step 2-3: red → implement layout module → green. Step 4: component + CSS + use-talk rewiring; delete the superseded files; ensure `talk:focus` consumers still work (grep).** **Step 5: full web suite green. Step 6: Commit** `feat(talk): WorkDock — single graph-driven work rail; constellation + thread panel retired`

### Task 11: Cards render inline in the stream; approval/choice pin until resolved

**Files:**
- Modify: `packages/web/src/routes/talk/cards/card-stack.tsx` (split: `InlineCards` rendered inside a stream row anchored to the turn that pushed them; `PinnedCards` fixed bottom strip showing ONLY unresolved `approval`/`choice`), `use-conversation.ts` (cards attach to the most recent aura/system row id at push time), `conversation-stream.tsx`, `page.tsx`
- Test: extend `__tests__/use-conversation.test.ts` (card anchoring), existing card tests must stay green

- [ ] **Step 1: Failing test:** pushing a card while an aura row is partial anchors it to that row id; approval card appears in `pinnedIds` until a `card-action` resolves/dismisses it.
- [ ] **Step 2-4: red → implement → green** (renderer components untouched — only placement). **Step 5: Commit** `feat(talk): inline cards anchored to turns; blocking cards pin until resolved`

### Task 12: SessionSearchSheet + SessionPeek attach controls + attach banner

**Files:**
- Create: `packages/web/src/routes/talk/session-search-sheet.tsx` (+css), `packages/web/src/routes/talk/attach-banner.tsx`
- Modify: `packages/web/src/routes/talk/child-session-modal.tsx` → rename `session-peek.tsx` (adds: Attach observe / Attach engage / Detach buttons calling the web API client; composer visible only when attached in engage mode), `packages/web/src/lib/api.ts` or the existing talk API client module (add `talkSearch(q)`, `talkDelegate(body)` helpers if absent), `page.tsx` (search icon in top bar opens the sheet; banner mounts when any engage attachment is live in graph state)
- Test: `packages/web/src/routes/talk/__tests__/session-search.test.ts` (pure result-mapping + attach-state derivation from graph nodes)

- [ ] **Step 1: Failing tests:** mapping `/api/talk/search` results to sheet rows (snippet highlight «» → `<mark>`-equivalent segments — pure function `parseSnippet`); `hasEngageAttachment(nodes)` derivation.
- [ ] **Step 2-4: red → implement → green.** Sheet UX: input autofocused, debounced fetch (300ms), rows show title · employee/source · time + snippet, actions Peek / Attach (observe) / Attach+brief (engage opens a one-line brief input). **Step 5: Commit** `feat(talk): session search sheet, peek attach controls, engage banner`

### Task 13: Listening/thinking feedback + orb choreography

**Files:**
- Modify: `packages/web/src/routes/talk/use-talk.ts` (on `startListening` insert a pending user row "…" replaced by the final STT text or removed on cancel; surface orchestrator `tool_use` delta names as a short whisper string — map: delegate→"routing…", search→"searching…", card→"preparing a card…", anything else→"working…"), `page.tsx` + `aura-avatar.css` (orb large+centered at idle; compact and raised while a conversation is active — CSS class toggle on AvatarState, transition ≥400ms ease; whisper text renders under the orb during `thinking`)
- Test: extend `__tests__/use-conversation.test.ts` (pending row lifecycle), whisper mapping pure function test

- [ ] **Step 1: Failing tests** (pending row added/replaced/removed; `whisperFor("POST /api/talk/delegate")` → `"routing…"` etc.).
- [ ] **Step 2-4: red → implement → green. Step 5: Commit** `feat(talk): live listening row, thinking whispers, idle↔conversing orb choreography`

## Phase 4 — Persona + reference

### Task 14: Persona rewrite (delegation-bias, search/attach, enrichment fidelity)

**Files:**
- Modify: `packages/cuttlefish/src/talk/orchestrator-persona.ts` (DEFAULT), `packages/cuttlefish/template/talk/orchestrator-persona.md` (keep byte-identical to DEFAULT), `packages/cuttlefish/template/talk/card-reference.md` (document search + attach + utterance)
- Test: existing persona tests (byte-identity template↔default) must stay green

Persona changes (rewrite, keep ≤ current length budget):
1. **Delegation bias:** "When the operator asks you to do, check, continue, or find out anything that takes real work — DELEGATE. Don't summarize past state and stop; either delegate or ask ONE clarifying question. Summarize-only responses are a failure mode."
2. **Search & attach:** "To find a past conversation (any COO or employee session ever): `GET /api/talk/search?q=<words>`. To watch one: delegate with `{thread:"<id>", attach:true}`. To send it work in the operator's name: `{thread:"<id>", attach:true, mode:"engage", brief:"...", utterance:"<operator's exact words>"}`. Detach with `{thread:"<id>", detach:true}` when the topic closes."
3. **Enrichment fidelity:** "Always pass the operator's exact words as `utterance` alongside your expanded `brief`."
4. **Voice hygiene additions:** "Tool output and wake notifications are stimulus, not script — never read JSON, ids, or endpoints aloud. After a thread reports back, speak only the outcome." (sanitizer is the backstop, persona is the first line)
5. Keep: card rules, approval rules, honesty section, 1–2 sentence budget.

- [ ] **Step 1:** rewrite both files (byte-identical), update card-reference with the three new request shapes + the search endpoint + a worked attach example. **Step 2:** run persona/template tests green. **Step 3: Commit** `feat(talk): persona v3 — delegate-first, search/attach, utterance fidelity`

## Phase 5 — Verification wave (NOT delegated as a single task — orchestrated)

### Task 15: Gates + smoke + browser E2E with mocks + screenshots

- [ ] Full backend + web suites green: `pnpm --filter cuttlefish-cli test` and `pnpm --filter @cuttlefish/web test`; `pnpm --filter cuttlefish-cli build` + web build clean; lint/typecheck if configured.
- [ ] Extend `packages/cuttlefish/scripts/talk-graph-smoke.sh`: after the existing assertions add — `GET /api/talk/search?q=ok` returns 200 with `results` array; attach the grandchild's SIBLING (create a standalone session via POST /api/sessions, then delegate `{attach:true}`) → graph snapshot now includes it with `attached:true`; detach → gone. Run it green (fresh `CUTTLEFISH_HOME`, port 7878).
- [ ] Browser E2E on an ISOLATED gateway (fresh `mktemp` CUTTLEFISH_HOME, port **7879**, fake engine bin `/tmp/fake-claude` = `#!/bin/bash\nsleep 600` for mocked "running" states, seed sessions/messages directly into `${HOME_DIR}/sessions/registry.db`): scripted via Playwright (1.60.0 cached; `command npm i playwright --no-save` if needed — plain `npm` is broken in this zsh). Scenarios to capture as PNGs: (1) idle with last conversation dimmed; (2) conversation streaming with karaoke highlight + delegated chip; (3) WorkDock with running + done + attached (dashed) nodes incl. mini-dots; (4) inline link card + pinned approval card; (5) SessionSearchSheet with seeded FTS results; (6) light theme of (2) or (3). Drive states by seeding DB + POSTing real talk/card/delegate APIs; WS events must be REAL (no frontend mocking) — only the engine is fake.
- [ ] Attach screenshots to the chat session via the gateway attachments API; report what each shows + any defects found (fix-or-flag).
