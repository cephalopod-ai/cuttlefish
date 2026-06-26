# /talk Stage Redesign — Design

**Date:** 2026-06-10
**Branch:** `talk-conversation-first` (continues on top of the conversation-first work, HEAD c65ff08)
**Status:** Approved by proxy — the operator delegated the redesign decisions explicitly ("I give you permission to redesign it however you like") and is reviewing results in the morning. Judgment calls are marked **[JUDGMENT]**.

## Problem

Operator feedback after live testing: "The UI looks very cluttered and the elements stack on top of each other. This to me screams that it is not following any design principles." And the vision: the orb "should not be the centerpiece at all times — it could become smaller, shrink and animate to the top when it needs to display some information."

Diagnosis (full version in the analysis session) — the clutter has one root cause with eight symptoms:

> **There is no layout system.** Every region — conversation stream, work dock, attach banner, pinned cards, bottom controls — is an independent `position: absolute` overlay, all at `z-index: 20`, each reserving space with hardcoded pixel insets (150px, 96/148px, 52px, 44px) that don't reference each other.

Symptoms grounded in code:
1. No master layout — root is `relative h-dvh`, every child absolute (`page.tsx:112-361`).
2. Hardcoded space reserves that don't scale (`conversation-stream.css:14`, `page.tsx:232`).
3. Orb "compact" mode is still 0.4-viewport/210px with glow bleeding `-26%` beyond bounds into text (`page.tsx:400-402`, `aura-avatar.css:24`).
4. Four regions at the same `z-index: 20` with no intentional layering.
5. Stream is a fixed band, not responsive to banner/cards presence.
6. Attach banner computes its own top offset independent of the top bar.
7. Orb stays HERO during the first thinking beat (`conversing` requires `rows.length > 0`, `page.tsx:205`).
8. No motion orchestration — each component animates with its own duration/easing (480ms, 620ms, 200ms…).

## Design principles adopted (from Siri/ChatGPT-voice/Gemini research)

The industry consensus: every major assistant retreated from the hero-orb. Siri went full-screen → compact orb → edge glow with zero footprint; ChatGPT folded voice into the transcript; Gemini collapsed into a pill. Principles we adopt:

1. **The assistant is a state, not a place** — /talk is one screen whose regions change prominence; no modal voice mode.
2. **The orb earns its size; content always outranks it** — hero only when there is nothing else to show.
3. **One primary focal point per state** — exactly one element owns the stage; everything else is secondary.
4. **The transcript is the spine** — whenever words exist, the transcript owns the center.
5. **Speak the summary, show the substance** — cards are glanceable; voice never reads them aloud.
6. **Morph, don't teleport** — the orb is ONE element animating between roles; never unmount/remount.
7. **One mover per transition** — the orb translates/scales; everything else fades or slides briefly; staggered, not parallel.
8. **Ambient ≠ interactive** — working status is a slow, low-contrast pulse + one status line, not a live region grabbing attention.
9. **No persistent chrome** — controls appear contextually.
10. **Reduce-motion-safe** — every animation has a crossfade fallback; transitions are interruptible.

Anti-patterns (hard bans): permanent hero orb; multiple simultaneous live regions; full-screen takeover; elements appearing from nowhere; decorative motion.

## Approaches considered

**A. Minimal re-staging** — keep absolute positioning, tune coordinates/z-indexes to stop collisions. Cheap, but leaves the root cause (no layout system); the next feature re-introduces clutter. Rejected.

**B. Stage manager + grid layout + orb dock (CHOSEN)** — one derived `StageState` drives everything; the page becomes a CSS grid of named zones in normal flow; the orb morphs between `hero` (center, large) and `docked` (small, top-center) as one continuous element. Fixes the root cause, keeps all salvageable component logic (stream rows/karaoke, dock chips, card system, search/peek).

**C. Edge-glow radical** — orb dissolves into a screen-edge glow whenever content exists (Apple Intelligence endgame). Boldest, but discards the orb identity the operator likes (hue-morph per thread) and is riskier to land overnight. **[JUDGMENT]** We take its spirit — during `content` stage the docked orb drops to its most minimal form — but keep the orb visible. Edge-glow can be a later experiment.

## The design

### 1. Stage state machine (`stage.ts` — new, pure)

One pure function derives the stage from existing talk state (no new stores):

```
deriveStage({state, hasRows, pinnedCards, searchOpen}) →
  { mode: 'hero' | 'conversing' | 'content', orb: OrbRole }

mode: 'hero'        — state idle|listening AND no rows AND no pinned cards.  Stage owner: ORB.
mode: 'conversing'  — rows exist OR state is thinking|speaking (first thinking beat included). Owner: TRANSCRIPT.
mode: 'content'     — unresolved pinned card(s) exist (approval/choice). Owner: CARD.
```

Key fixes vs today: thinking with zero rows already leaves `hero` (symptom 7); pinned cards push to `content` where the transcript dims and the card is the single focal point.

Debounce: mode changes hold for ≥600ms before reverting (no churn on sub-second state flickers).

### 2. Layout: named grid zones, normal flow (`page.tsx` restructure)

```
┌─────────────────────────────────────────┐
│ top-bar (h:44, z:chrome)                │
│ attach-banner (flow, collapses to 0)    │
│ orb-dock (flow; h:0 in hero mode)       │
│ ┌─────────────────────────┬──────────┐  │
│ │ stage                   │ dock-rail│  │
│ │ (transcript OR hero orb │ (WorkDock│  │
│ │  OR content card focus) │  right)  │  │
│ └─────────────────────────┴──────────┘  │
│ pinned-cards (flow, collapses to 0)     │
│ controls (mic / input, z:chrome)        │
└─────────────────────────────────────────┘
```

- Root becomes `display:grid; grid-template-rows: auto auto auto 1fr auto auto; grid-template-columns: 1fr auto; height:100dvh`. Every region is a grid child in normal flow. **No region computes its own insets; all the hardcoded `calc(env(...)+Npx)` reservations are deleted.**
- The conversation stream fills the `stage` cell (`position:relative; overflow-y:auto`) — its size automatically responds to banner/cards/input presence because the grid reflows.
- WorkDock becomes the `dock-rail` column child (right side, vertically centered within the row, collapses to a dots-rail exactly as today; overlay behavior on <720px screens where it floats over the stage with a scrim-free compact form).
- Pinned cards and attach banner are flow rows that animate their height 0→auto (grid-row collapse), so the stream NEVER hides behind them.
- Z-index tokens: `--z-stage: 10; --z-rail: 20; --z-chrome: 30; --z-overlay: 40` (search sheet/peek). No component declares a literal z-index.

### 3. Orb choreography: hero ↔ docked morph

The orb is one element whose box is animated between two layout anchors:

- **hero**: centered in the `stage` cell; size `min(38vmin, 300px)`; glow allowed.
- **docked**: in the `orb-dock` row, top-center; size **56px**; glow clipped to ≤8px halo (no bleed into text); whisper/status line renders beside/below it in the dock row.

Transition: FLIP-style — measure both rects, animate `transform: translate+scale` over **~500ms** with an overdamped-spring/emphasized easing; the dock row's height animates in parallel. One mover rule: while the orb morphs, incoming content fades in 300ms decelerate, delayed 100ms; outgoing fades 200ms accelerate. `prefers-reduced-motion`: crossfade 150ms.

Orb per state (within its current role):
- idle/hero: slow ambient breathing (exists today).
- listening/hero: mic-energy amplitude (exists today).
- thinking/docked: shimmer + whisper text ("routing…", "searching…") in the dock row.
- speaking/docked: pulse with TTS (equalizer already exists; scaled down).
- working/docked: slow ambient pulse + thread-hue morph (existing channel-identity hue preserved); satellite mini-dots removed at this size — the WorkDock rail is the detailed view.
- content stage: orb stays docked at its dimmest/stillest; the pinned card gets the focus treatment (transcript dims to 0.5 opacity).

### 4. Region-by-region changes

- **ConversationStream** — KEEP rows/karaoke/chips/jump-pill logic. CSS changes only: becomes the stage cell child; remove fixed insets + `pointer-events:none` hack; max-width 640px **[JUDGMENT** — slightly narrower than 720px for measure/readability**]**; in `content` mode gets `.is-dimmed`.
- **WorkDock** — KEEP chips/menu/dots logic. Moves into `dock-rail` grid column; vertical centering via the column, not `top:0;bottom:0` overlay.
- **Cards** — KEEP card system + deck phases. Pinned strip becomes a flow row; in `content` mode the newest unresolved approval/choice card scales up slightly (1.02) and gets the only full-contrast treatment on screen.
- **AttachBanner** — becomes flow row under the top bar; no own safe-area math.
- **Bottom controls** — stay the `controls` row; type-to-talk input expands the row (grid reflows the stream automatically — deletes the `.cstream--input-open` patch from c65ff08).
- **Whispers** — move from "under the centered orb" to the orb-dock row (beside the docked orb), one line, truncated.
- **Top bar** — unchanged content (title, search, mute), now a grid row.
- **Search sheet / session peek** — unchanged (already modal overlays at `--z-overlay`).

### 5. Design tokens (new `talk-tokens.css`)

- Spacing: `--space-1..8` (4/8/12/16/24/32/48/64).
- Motion: `--motion-hero: 500ms var(--ease-emphasized); --motion-enter: 300ms var(--ease-decel); --motion-exit: 200ms var(--ease-accel); --motion-ambient: 900ms ease-in-out`.
- Z-index scale as above. All talk CSS migrates to these tokens; no new hardcoded px for spacing/duration in the touched files.

### 6. What does NOT change

Backend, persona, TTS pipeline, graph/store logic, search/attach APIs, card data contracts, use-conversation reducer, audio player. This is a presentation-layer redesign: `page.tsx`, talk CSS files, orb shell, plus a new pure `stage.ts` + `talk-tokens.css`.

### 7. Testing

- `stage.ts`: pure unit tests for every mode derivation + debounce.
- Component tests: stream/dock/cards render under the new layout contract (no absolute-inset assertions remain).
- The 9-scenario browser E2E re-run on an isolated gateway + fresh screenshots; explicit checks: orb docks on first thinking beat, no element overlap at 1280×800 and 390×844 (mobile), reduced-motion path renders.

## Error handling

Stage derivation is pure and total — unknown states fall back to `conversing` (transcript visible is the safest default). FLIP measurement failures (element not mounted) skip animation and snap to final layout — layout correctness never depends on the animation running.

## Post-review deviations (2026-06-10)

1. **Stagger choreography partially wired.** The content enter/exit stagger choreography (spec §"one mover" timings; tokens `--motion-enter/exit/ambient`) is wired only for the orb dim + dock-row transition. Existing per-component entrances (stream rows, cards) keep their current timings deliberately — changing them sight-unseen overnight risks regressing a look that works. The tokens stay as the target vocabulary for a follow-up pass.
2. **Content-stage orb treatment = CSS opacity dim.** The orb canvas keeps animating beneath; a scoped `opacity: 0.45` on `.talk-orb-layer` does the quieting (no prop/JS changes).
3. **Focal ring on the newest pinned card only** (was: every pinned card). New cards append to the source array, so the newest is the last live card in the pinned deck; exiting cards are skipped via an `:nth-last-child(... of ...)` selector so a card mid-exit never transiently takes the ring.
