# Chat redesign — focused sidebar + frosted-pill header

Branch: `chat-focus-pills` (off `main`). NOTHING merged/deployed until approved.
Mockups: `/tmp/cuttlefish-mockups/` (sidebar = Variant A, flat Today/Yesterday).

## Workstreams
1. **Focused sidebar** (priority — report first) — flat Today/Yesterday recency list.
2. **Transparent header → frosted pills** — after sidebar approval.

---

## Data-layer finding (verified in source)

`GET /api/sessions` (default, no params) → `listRecentPerGroup(50, portalSlug)` in
`packages/cuttlefish/src/sessions/registry.ts:780`:
- The **50 most-recent sessions per group** (each employee + `__direct__` + `__cron__`),
  globally ordered by `last_activity DESC`.
- Plus a `counts` map = **true total per group** (used today for "+N more").
- The web hook comment (`use-sessions.ts`) saying "top-N = 8" is **stale** — server
  const is `SESSION_LIST_PER_GROUP = 50` (`gateway/api.ts:83`).

**Conclusion: no backend change needed for Today/Yesterday.**
50 recent/group reliably captures every today+yesterday chat (an employee would need
>50 chats in a *single day* to drop one — not realistic). Today/Yesterday buckets are
built from the loaded payload; the "Older" summary count uses the authoritative
`counts` totals, so it's exact even though the deep tail isn't all loaded.
- Edge limit (documented, accepted): if one employee had >50 chats in a day, the
  oldest of that day wouldn't appear until "Older" is expanded. Vanishingly rare.
- Search already spans ALL sessions server-side (`searchSessions`, `?q=`), unchanged.

## Sidebar design decisions
- **Variant A**: flat, recency-sectioned. One row per *session* (not per employee).
  Row = avatar (+status dot) + employee name + time (line 1), chat title (line 2),
  pin icon if pinned.
- Sections: **Today**, **Yesterday** (local-midnight boundaries).
- **Older** collapses to one line: "Older · N chats across M employees", expands
  **in place** to the EXISTING per-employee grouped list (EmployeeRow + per-group
  "load more") — reuses tested code, preserves full access to old sessions (no data
  loss), and the task explicitly allows "keep the old grouping" for Older.
- **Scheduled** (cron) section: unchanged.
- **Team** (contactable, session-less) footer: unchanged.
- Search mode: flat results, no sections (search spans everything).
- Virtualization preserved via a unified `VirtualItem[]` (section headers + flat
  rows + employee rows + cron + older-line).
- **Pinned**: kept in context menu; pinned sessions show a pin marker in their day
  bucket; Older-expanded keeps pinned-employee float. No separate "Pinned" section
  (avoid scope creep) — open question to confirm.

## Files touched
- `packages/web/src/components/chat/chat-route-helpers.ts` — add `bucketByDay` date helper.
- `packages/web/src/components/chat/__tests__/chat-sidebar-helpers.test.ts` — bucketing tests.
- `packages/web/src/components/chat/chat-sidebar.tsx` — focused layout.
- (header phase, later) `page-layout.tsx`, `chat-tabs.tsx`, `routes/chat/page.tsx`.

## Resolved questions
- Pinned: CONFIRMED — pin-marker-in-bucket, NO separate Pinned section (per reviewer).
- Helpers: `bucketByDay` / `startOfLocalDay` / `summarizeOlder` live in
  chat-route-helpers.ts (shared with a parallel session, now reconciled — single
  definition, no duplication). use-sessions.ts comment fixed (top-N 8 → 50).

## What changed (sidebar phase)
- `chat-route-helpers.ts`: `bucketByDay`, `startOfLocalDay`, `summarizeOlder` (pure).
- `chat-route-helpers.test.ts`: 26 tests (bucketing + older summary, DST/month edges).
- `chat-sidebar.tsx`:
  - New `FlatSessionRow` (two-line: avatar+dot, name+time / chat title) — one row
    per chat for Today/Yesterday/search.
  - Grouping useMemo rewritten: buckets non-cron sessions into Today/Yesterday flat
    rows; tallies `recentByGroup`; computes the Older summary from authoritative
    `counts`; derives the Older drawer's per-employee groups (only groups with
    older chats).
  - `olderExpanded` state (localStorage-persisted). Collapsed → one summary line;
    expanded → existing EmployeeRow drawer (load-more preserved).
  - Unified `VirtualItem[]` (section | flat | older-line | older-header | employee
    | cron-*), single `renderItem()` shared by virtualized + plain paths.
  - Keyboard nav order + delete-next-selection updated to the new visible order
    (de-duped). Cron "Scheduled" + Team footer + search (spans all) unchanged.
- `use-sessions.ts`: stale PER_GROUP comment corrected (8 → 50).

## Verification
- `pnpm --filter @cuttlefish/web typecheck` — clean.
- web tests — 457 passed (41 files), incl. 26 helper tests.
- Screenshots in /tmp/chat-redesign/: desktop.png, desktop-tall.png,
  sidebar-crop.png (Today/Yesterday/Older line/Scheduled), desktop-older-expanded.png
  + older-expanded-crop.png (Older drawer), mobile-sidebar.png (390, edge-to-edge).
- Live data via `pnpm --filter @cuttlefish/web dev --port 5199` (proxies API→8888).

## Focused filter (added after sidebar approval)

Default view shows ONLY the operator's own top-level chats; everything else is
one tap away.

**Predicate (verified against the live Session shape + real payload):**
`isFocusedSession` = NOT cron (`source==='cron'` or `sourceRef` starts `cron:`)
AND `parentSessionId` empty AND `source ∈ {web, slack, talk}`.
- Verified on 575 live sessions: 68 focused (63 web + 5 talk); hidden = 457
  delegated children (web w/ parentSessionId set) + 50 cron runs.
- `userId` is uniformly null on this single-user install → NOT used; the reliable
  top-level-vs-spawned signal is `parentSessionId`.
- `talk` included (user-initiated voice). Brief said {web,slack}; flagged for
  confirmation. Allowlist → unknown/internal sources hidden by default.

**UX:** segmented **[Focused | All]** toggle under the "Chats" title (replaces the
"All conversations" subtitle). Default Focused, persisted in
`localStorage["cuttlefish-sidebar-focus-mode"]`. One tap, reversible.
- Focused gates Today/Yesterday/Older to focused sessions; **Older in focused mode
  = older user-initiated chats as flat rows** (computed from loaded sessions; deep
  tail via search). All mode = the authoritative counts-based per-employee drawer.
- Cron RUN sessions never appear as Today/Yesterday rows (they're a separate
  "Scheduled" section, which stays in BOTH modes — per the brief).
- Empty focused view with hidden automated → inline "View all (N automated)" CTA.
- Search still spans ALL sessions regardless of mode. Nothing destructive.

Files: chat-route-helpers.ts (`isFocusedSession` + `FOCUSED_SOURCES`),
chat-route-helpers.test.ts (+4 tests = 30), chat-sidebar.tsx (focusMode state,
toggle, pool gating, focused-Older flat rows, nav/empty-state).

## Verification (current)
- `typecheck` clean · **461 web tests pass** (41 files; +4 isFocusedSession).
- Screenshots in /tmp/chat-redesign/: focused-desktop-crop.png / all-desktop-crop.png,
  focused-mobile.png / all-mobile.png (Focused TODAY 4 vs All TODAY 13).

## Header phase — transparent header → frosted pills

Dropped the solid h-12 chat header; main content is full-bleed under a soft top
gradient SCRIM, with two frosted corner pills (reusing the mockup `.pill` recipe:
backdrop-blur(20px) saturate(1.3) over rgba(30,28,22,0.55), 0.5px white border,
overlay shadow, full radius).

- **LEFT pill**: sidebar/list toggle + breadcrumb (`crumb employee / chat title`).
  On scroll (thread scrollTop > 24) it sheds the title → [toggle + 24px avatar].
  Mobile adds a leading ≡ that opens the global-nav drawer (the 56px rail is
  desktop-only, so nav isn't lost).
- **RIGHT pill**: search (⌘K) · tabs/grid (open-tabs popover, replaces the strip) ·
  ┊ · new (+, accent) · more (…). The Chat/CLI view toggle moved into the … menu.
- **Scrim**: gradient (not a border); content scrolls *under* it. Thread first row
  gets 64px top padding via a scoped CSS rule on `.chat-messages-scroll` (no edits
  to chat-pane/chat-messages).
- **Mobile**: the two pills REPLACE the 48px "≡ Jimbo +" bar. Thread edge-to-edge.
  Pills hidden over the mobile chat-LIST view (the sidebar keeps its own header);
  shown over the thread. Collapse to icons-only on scroll.

**Constraints honored:** thread stays FULL-WIDTH (ignored the mockup's 720px
centered column); NO avatars/sender labels added inside message rows; only
page-layout.tsx, chat-tabs.tsx, routes/chat/page.tsx touched (+ the ChatTabBar→
ChatHeaderPills test rename). Scroll detection is a capture-phase listener on the
pane wrapper — ChatPane untouched.

**How it works:** PageLayout gains a `chromeless` prop (chat route passes it) that
drops MobileHeader + DesktopHeader. MobileNavDrawer extracted from MobileHeader and
reused by the pill's ≡. Search reuses the existing GlobalSearch via a synthetic ⌘K
(global-search.tsx untouched).

Known minor follow-up: CLI view's top row sits a touch high under the pills (no
class to pad cleanly without touching chat-pane). Chat view is correct.

### Extending the pill/transparent header to OTHER pages (assessment, not built)
- The pieces are already generic: `MobileNavDrawer` + `chromeless` live in
  page-layout; the pill primitives (`ChatHeaderPills`/`PILL_CLASS`) are
  self-contained in chat-tabs. Lifting `PILL_CLASS` + a small `<Pill>/<PillButton>`
  into a shared `components/ui/pill.tsx` would make them reusable.
- Other pages (org/kanban/cron/logs/limits) currently render their chrome via the
  default MobileHeader + DesktopHeader (breadcrumbs). To pill-ify them: pass
  `chromeless`, then add a per-page right-pill of page actions + a left-pill title.
  The scroll-collapse + scrim only matter for scrolling content (logs/kanban);
  static pages can use a static (non-collapsing) pill.
- Recommendation: it's a clean ~half-day generalization — extract a shared
  `<PageHeaderPills>` (title + actions + optional scroll-collapse) and adopt it
  page-by-page. NOT a single shared component drop-in, because each page's actions
  differ; but the material, drawer, and chromeless plumbing are shared. Low risk.

## Status
- [x] data-layer investigation (no backend change needed)
- [x] date-bucketing helper + tests
- [x] focused sidebar layout (Variant A)
- [x] focused-filter (user-initiated default + All toggle)
- [x] frosted-pill header (scrim + corner pills, mobile, scroll-collapse)
- [x] preview screenshots — header top + scrolled, desktop 1440 + mobile 390
- [ ] report → STOP for final review  ← HERE
- nothing merged/deployed

---

## Phase 3 — Composer + message simplicity (Claude-app aesthetic)

Mockup: `/tmp/cuttlefish-mockups/out-composer.png` (+ `composer.html`, Ledger dark).
Scope: composer restyle, model dropdown redesign + context usage, message action row.

### Files
- `packages/web/src/components/chat/chat-input.tsx` — composer → rounded card
  (`bg-secondary`, 22px radius, `shadow-card`); textarea on top, a toolbar row
  below: `[+ attach]` · `[model chip]` · spacer · `[lang?]` · `[mic]` ·
  `[send/stop]`. Send is the accent circle (stop = red while streaming, which
  preserves interrupt; the disabled send is hidden during a turn). Ghost buttons
  are round/bordered. ALL existing behaviour preserved: slash + @mention + skills
  autocomplete, STT/whisper dictation + waveform + language picker, drag-drop
  attach, paste-image, interrupt, terminal/CLI slots, `selectorSlot`.
  The old meta strip lost the selector (now in-toolbar) and the `/`-commands /
  `@name` text hints (discoverable by typing); it keeps only the quiet `?`
  shortcuts button + terminal slots, right-aligned.
- `packages/web/src/components/chat/model-selector-row.tsx` — was 3–4 inline
  metadata triggers; now ONE chip trigger (`✦ Opus 4.8 · High ▾`, effort hidden
  < sm) opening ONE consolidated dropdown (opens upward, `side="top"`): engine
  header (`Engine · Claude`, `(locked)` mid-chat), model radio list with accent
  ✓, effort pill row (Low/Medium/High; hidden for effort-less models), a
  **context-usage footer** (`Context · 170k / 1000k` + accent bar; orange ≥75%,
  red ≥90%/over; fresh chat shows just the window, no bar), and engine switch —
  a `Switch engine…` submenu on a NEW chat, "Start a new chat to switch engine"
  when locked. Cascading + refresh-models preserved.
  Pure `formatContextUsage(tokens, window)` + `fmtK` exported for testing.
- `packages/web/src/components/chat/chat-messages.tsx` — subtle action row under
  each assistant message: **copy** (clipboard, ✓ feedback) + **retry** (resends
  the prior user message via `onRetry`; disabled while loading). Full-width +
  no-avatars preserved.
- `packages/web/src/components/chat/chat-pane.tsx` — wires
  `onRetry={(t) => void handleSend(t)}`.

### Thumbs / ⋯ decision
No feedback/rating endpoint exists anywhere in the gateway (grepped cuttlefish + web).
Wiring a thumbs sink = new API route + storage = non-trivial → **thumbs OMITTED**
(no dead buttons). The `⋯ more` button is also omitted: no genuinely-distinct
second-tier per-message action exists to put in it without it being a placeholder.
Action row ships as copy + retry only — both real. (Follow-up if wanted: add a
`POST /api/sessions/:id/messages/:mid/feedback` sink, then re-introduce thumbs.)

### Tests
- New `__tests__/context-usage.test.ts` — `fmtK` + `formatContextUsage`
  (label, thresholds orange/red, fresh-chat 0, over-window cap). 12 assertions.
- Rewrote `__tests__/model-selector-row.test.tsx` to the chip surface (old inline
  Engine/Model/Effort buttons are gone). `pnpm typecheck` clean; full web suite
  **465 passed**.

### Preview
Dev `vite --port 5219` (GATEWAY_PORT=8888 proxy) against live API. Headless
Chromium (Playwright) screenshots in `/tmp/chat-redesign/`:
`desktop-1-composer-closed.png`, `desktop-2-model-dropdown.png` +
`desktop-2b-dropdown-zoom.png`, `desktop-3-assistant-actions.png`,
`mobile-1-composer-closed.png`, `mobile-2-model-dropdown.png`.

Minor cosmetic note (not changed): a 1M window renders as `1000k` via `fmtK`;
could special-case `M` later if desired.

---

## Phase 3b — Borderless pass (Claude's calm aesthetic)

Operator feedback: the "light border lines of the input and model selections" looked ugly.
Removed every 1px hairline from the composer + model selector; separation now
comes from soft fills + shadow + whitespace (Claude-style). No token-border at rest.

### chat-input.tsx
- Composer container: dropped `border-t border-t-[var(--separator)]` and the
  `material-regular` band → `bg-[var(--bg)]` flush with the thread, plus a soft
  top **scrim gradient** (transparent→bg) instead of a divider line.
- Composer card: removed the rest-state `border` + the solid `border-[var(--accent)]`
  streaming border. Separation = `var(--shadow-card)` (already carries a per-theme
  0.5px ring). Streaming state = a low-opacity **accent ring** via composed
  box-shadow (`…, 0 0 0 1.5px color-mix(accent 38%))`), not a 1px border.
- Attach + mic buttons: dropped `border-[var(--border)]` → borderless ghost icons
  (transparent, hover `fill-secondary`). Red mic-recording state kept.
- Language picker pill: dropped its border (soft `fill-tertiary` kept).
- `?` shortcuts + `⌨` terminal: dropped the `fill-tertiary` kbd box → quiet
  borderless glyphs.

### model-selector-row.tsx
- Chip trigger: removed `border` + `bg-[var(--fill-tertiary)]` pill → plain text
  trigger (`✦ Opus 4.8 · High ▾`), `text-secondary` → `text-primary` on hover,
  subtle hover `fill-secondary` only. No box, no fill at rest.
- Dropdown content + subcontent: dropped the `border-[var(--border)]` (set
  `border-0`) → borderless elevated surface on `shadow-overlay` + `bg-tertiary`
  (the overlay shadow's built-in 0.5px ring is the only, per-theme faint edge).
- Effort pills + context bar already use soft fills (no hard borders) — unchanged.

Left intact (out of scope, not "input/model selection"): the transient slash/
mention autocomplete popovers still use a separator hairline.

### Verify
- `pnpm typecheck` clean; full web suite **465 passed** (no tests asserted the
  removed border classes).
- Both DARK + LIGHT verified: light keeps separation via the soft card/overlay
  shadow (does not collapse/flat-merge). Screenshots `/tmp/chat-redesign/`:
  `borderless-{dark,light}-{desktop,mobile}-{1-rest,2-focused-streaming,3-dropdown}.png`
  + `borderless-{dark,light}-composer-zoom.png`.

---

## Phase 4 — Claude-app polish pass (7 items)

Done on `main` directly (live :8888, COO rebuilds/restarts after review). Two
file-disjoint workstreams run in parallel via agent teams; integrated centrally.
Reference: operator screenshots IMG_3981 (Anthropic composer target), IMG_3982
(our light composer), IMG_3983 (light-mobile dark-pill bug).

### Item 1 — Light-theme fix (pills + scrim were rendering DARK in light mode)
- `globals.css`: new theme-aware token pair `--pill-bg` / `--pill-border`, added
  to ALL four theme blocks (dark-root, light, system-light, system-dark).
  Dark: `rgba(30,28,22,0.55)` / `rgba(255,255,255,0.10)`.
  Light: `rgba(251,249,242,0.72)` / `rgba(33,30,22,0.10)`.
- `chat-tabs.tsx` `PILL_CLASS`: hardcoded `bg-[rgba(30,28,22,0.55)]` /
  `border-white/10` → `bg-[var(--pill-bg)] border-[var(--pill-border)]`
  (backdrop-blur+saturate kept).
- `page.tsx` top scrim: hardcoded `rgba(20,18,15,…)` gradient → fades from
  `var(--bg)` → `color-mix(in srgb, var(--bg) 55%, transparent)` → transparent.
- Verified light pills + scrim now read light; dark unchanged.

### Item 2 — Composer breathing room
- `chat-input.tsx` card padding `px-space-3/pt-space-2/pb-1.5` →
  `px-space-4/pt-space-3/pb-space-2`. Placeholder sits with more air, matching
  IMG_3981. Tasteful, both themes.

### Item 3 — Full click-to-focus
- `chat-input.tsx`: `onPointerDown` on the composer card wrapper →
  `preventDefault()` + focus the textarea, so clicking anywhere (incl. gaps
  between toolbar buttons) lands the caret in the input. Every real control
  (textarea, attach, selectorSlot wrapper, language picker, mic, stop, send)
  `stopPropagation`s so they keep working. Runtime-confirmed: clicking empty
  composer space sets `document.activeElement` = `chat-textarea`.

### Item 4 — Mic: two gestures + integrated waveform
- `chat-input.tsx`: exported pure `classifyMicGesture(downAt, upAt, threshold=250)`
  → 'hold' | 'tap'. Pointer-driven `handleMicPointerDown`/`handleMicPointerUp`
  (refs, pointer capture, `touch-none`): TAP-AND-HOLD = push-to-talk
  (release stops+transcribes); QUICK TAP = toggle (tap on / tap off). transcribing
  / no-model / error states preserved; transcript still inserted via fillTextarea.
- New `mic-waveform.tsx`: compact DPR-scaled canvas (4 bars, currentColor) reacting
  to `analyser` audio level; crisp, ~20×16 inside the 34px button footprint. While
  recording the mic BUTTON ITSELF morphs into the waveform (red state), morphs back
  to the glyph on stop. Replaced the separate 64px `<SttWaveform>` strip.
- `stt-waveform.tsx` DELETED (dead after the above; no remaining imports).

### Item 5 — Right pill trim
- `chat-tabs.tsx`: removed the Search button AND the LayoutGrid "open tabs"
  TabSwitcher (+ its PillSep). Right pill = `+` and `⋯` only. Deleted the unused
  `TabSwitcher`, `onSearch` prop, and now-dead imports. `tabs/activeIndex/onSwitch/
  onClose` kept in the props type — tab STATE untouched, only the UI entry point is
  gone. `page.tsx` stops passing `onSearch`; removed dead `openGlobalSearch`.
  ⚠️ FLAG: this removes the ONLY header entry point to the tabs popover (intended
  per operator). ⌘W / ⌥⌘1-9 / ⌘⇧[ ] tab nav still work; no replacement entry point
  added.

### Item 6 — Right-pill `+` color
- `chat-tabs.tsx`: dropped the `accent` styling on `+` (was `text-[var(--accent)]`,
  red/tinted) → neutral `text-[var(--text-secondary)]`, matching `⋯`. Removed the
  now-unused `accent` capability from `PillButton`.

### Item 7 — Left pill + nav restructure
- `chat-tabs.tsx` left pill now renders ONLY `[Menu hamburger → onToggleSidebar]`
  + `[employee avatar, always]`. Removed the breadcrumb title (`crumbLabel`/`title`/
  scroll-to-avatar) and the PanelLeft expand/collapse toggle (+ those props).
- Hamburger takes over "show the list" (desktop = collapse toggle, mobile = chat
  list overlay) via existing `toggleSidebar`.
- Global NAV moved off the pill INTO the chat list: `chat-sidebar.tsx` gains an
  `onOpenNav` prop + a `Compass` icon button in the list header (next to "+ New").
  `page.tsx` wires `onOpenNav={() => setNavDrawerOpen(true)}` on both ChatSidebar
  instances. `page-layout.tsx` `MobileNavDrawer` lost its `lg:hidden` so the list
  nav button works on desktop too (drawer only renders when `open`).
- `page.tsx`: removed now-dead `threadScrolled` state + scroll listeners +
  `titleCase`/`headerCrumb`/`headerTitle`; kept `headerEmployee`/`headerAvatar`.
- Desktop 56px icon rail (`sidebar.tsx`) untouched → desktop has BOTH rail + list
  nav button.
  ⚠️ FLAG: left pill is now hamburger+avatar only; nav relocated into the chat list.

### Verification
- `pnpm --filter @cuttlefish/web typecheck` — clean.
- Full web suite: **473 passed (43 files)** — was 465 baseline + 8 new in
  `__tests__/mic-gesture.test.ts` (classifyMicGesture hold/tap thresholds +
  waveform bar-height/DPR-scale helpers).
- Dev preview `vite --port 5266` (GATEWAY_PORT=8888 proxy) against live API;
  headless Chromium (fake media) screenshots in `/tmp/chat-redesign/polish-*.png`:
  desktop+mobile × dark+light — composer at rest, composer recording (integrated
  waveform), trimmed right pill, simplified left pill, hamburger→chat-list→nav
  drawer flow. Light pills/scrim confirmed light (IMG_3983 bug fixed); click-to-
  focus confirmed at runtime.
- Pre-existing (NOT introduced, dev-only, stripped in prod): React "button cannot
  be nested in button" warning from the clickable session ROW containing its ⋮
  menu trigger (chat-sidebar row markup, present at HEAD, out of scope).

### Files (scoped commit)
chat-input.tsx, mic-waveform.tsx (new), __tests__/mic-gesture.test.ts (new),
stt-waveform.tsx (deleted), chat-tabs.tsx, chat-sidebar.tsx, page-layout.tsx,
routes/chat/page.tsx, routes/globals.css. Nothing merged to remote / no restart.
