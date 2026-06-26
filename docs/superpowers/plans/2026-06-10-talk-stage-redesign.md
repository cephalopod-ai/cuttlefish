# /talk Stage Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the absolute-overlay /talk layout with a stage-managed grid where the orb morphs between hero (center) and docked (top) roles and content always outranks it.

**Architecture:** A pure `stage.ts` derives one `StageMode` (`hero | conversing | content`) from talk state; `page.tsx` becomes a CSS grid of flow rows (top-bar / banner / orb-dock / main(stage+rail) / pinned / controls) driven by new design tokens; a single persistent `OrbLayer` spring-animates the orb between two measured anchors. Spec: `docs/superpowers/specs/2026-06-10-talk-stage-redesign-design.md`.

**Tech Stack:** React 18 + TypeScript (NO semicolons in packages/web), plain CSS files co-located per component, vitest, existing `motion.ts` spring (`useSpringValue`).

**Repo/branch:** `<worktree>`, branch `talk-conversation-first`. Run web tests with `pnpm --filter @cuttlefish/web test -- --run`, typecheck with `pnpm --filter @cuttlefish/web exec tsc --noEmit`, build with `pnpm --filter @cuttlefish/web build` (NEVER `--force`).

**Hard rules:** Do not touch backend (`packages/cuttlefish`) except nothing — this is presentation-only. Do not rename exported APIs used by tests. Repo is public: no real names/PII in code or commits. No `Co-Authored-By` lines in commits.

---

### Task 1: Design tokens + layout stylesheet

**Files:**
- Create: `packages/web/src/routes/talk/talk-tokens.css`
- Create: `packages/web/src/routes/talk/talk-layout.css`
- Modify: `packages/web/src/routes/talk/page.tsx` (imports only, top of file)

No unit tests (pure CSS); verification is typecheck + build + later tasks.

- [ ] **Step 1: Create `talk-tokens.css`**

```css
/**
 * Cuttlefish Talk — design tokens (stage redesign).
 *
 * Single source for z-index layering, spacing, and motion durations/easings on
 * the /talk surface. Components must reference these instead of literals so the
 * stage choreography stays coherent (one mover, everything else fades).
 */
:root {
  /* ---- z-index scale ---- */
  --z-stage: 10;   /* stage content + orb layer */
  --z-rail: 20;    /* WorkDock rail (narrow-screen overlay mode) */
  --z-chrome: 30;  /* top bar, bottom controls */
  --z-overlay: 40; /* search sheet, session peek, modals */

  /* ---- spacing scale ---- */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;

  /* ---- motion ---- */
  --ease-emphasized: cubic-bezier(0.2, 0, 0, 1);
  --ease-decel: cubic-bezier(0.05, 0.7, 0.1, 1);
  --ease-accel: cubic-bezier(0.3, 0, 0.8, 0.15);
  --motion-hero: 500ms var(--ease-emphasized);   /* the one mover (orb/dock) */
  --motion-enter: 300ms var(--ease-decel);       /* incoming content */
  --motion-exit: 200ms var(--ease-accel);        /* outgoing content */
  --motion-ambient: 900ms ease-in-out;           /* working pulses */
}
```

- [ ] **Step 2: Create `talk-layout.css`** (grid zones; consumed starting Task 3 — classes are inert until then)

```css
/**
 * Cuttlefish Talk — stage layout (stage redesign).
 *
 * The /talk page is ONE grid of flow rows. No region computes its own insets;
 * space is allocated by the grid, so banner/cards/input growth reflows the
 * stage automatically instead of overlapping it.
 *
 *   rows: top-bar / banner / orb-dock / main (stage + rail) / pinned / controls
 */
.talk-root {
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr) auto auto;
  height: 100dvh;
  width: 100%;
  overflow: hidden;
}

/* ---- row 1: top bar ---- */
.talk-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: max(env(safe-area-inset-top), 14px) var(--space-4) var(--space-2);
  position: relative;
  z-index: var(--z-chrome);
}

/* ---- row 2: attach banner(s); empty row collapses to 0 ---- */
.talk-banner-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-4);
}
.talk-banner-row:not(:empty) {
  padding-bottom: var(--space-2);
}

/* ---- row 3: orb dock — reserves space for the docked orb + whisper ---- */
.talk-orbdock {
  position: relative;
  height: 0;
  transition: height var(--motion-hero);
}
.talk-orbdock[data-active="true"] {
  height: 64px;
}
/* 56px anchor box pinned to the row centre — the OrbLayer chases its rect. */
.talk-orbdock__anchor {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 56px;
  height: 56px;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
/* Whisper / status line beside the docked orb. */
.talk-orbdock .talk-whisper {
  position: absolute;
  left: calc(50% + 44px);
  top: 50%;
  transform: translateY(-50%);
  margin: 0;
  max-width: min(38vw, 320px);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- row 4: main = stage (transcript) + rail (WorkDock) ---- */
.talk-main {
  position: relative;
  display: flex;
  min-height: 0;
}
.talk-stage {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  z-index: var(--z-stage);
}
.talk-rail {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  padding-right: max(env(safe-area-inset-right), 10px);
}
/* Narrow screens: the rail floats over the stage edge instead of stealing
   column width (chips expand leftward over the transcript margin). */
@media (max-width: 719px) {
  .talk-rail {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    z-index: var(--z-rail);
    pointer-events: none;
  }
  .talk-rail > * {
    pointer-events: auto;
  }
}

/* ---- row 5: pinned (blocking) cards; collapses to 0 when absent ---- */
.talk-pinned {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: var(--space-2) var(--space-4) 0;
  max-height: 46dvh;
  overflow: hidden;
}

/* ---- row 6: bottom controls ---- */
.talk-controls {
  position: relative;
  z-index: var(--z-chrome);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0 max(env(safe-area-inset-bottom), 22px);
}

/* ---- the persistent orb layer (Task 4) ---- */
.talk-orb-layer {
  position: fixed;
  left: 0;
  top: 0;
  z-index: var(--z-stage);
  pointer-events: none;
  display: grid;
  place-items: center;
}

/* ---- content stage: the pinned card is the focal point ---- */
.talk-root[data-stage="content"] .cstream {
  opacity: 0.5;
}
.talk-root[data-stage="content"] .talk-pinned .jt-card {
  box-shadow:
    var(--shadow-overlay),
    0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .talk-orbdock {
    transition: none;
  }
}
```

- [ ] **Step 3: Import both files in `page.tsx`** — add after the existing imports:

```tsx
import "./talk-tokens.css"
import "./talk-layout.css"
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @cuttlefish/web exec tsc --noEmit && pnpm --filter @cuttlefish/web build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/talk/talk-tokens.css packages/web/src/routes/talk/talk-layout.css packages/web/src/routes/talk/page.tsx
git commit -m "feat(talk): design tokens + stage layout stylesheet"
```

---

### Task 2: Stage state machine (`stage.ts`) — TDD

**Files:**
- Create: `packages/web/src/routes/talk/stage.ts`
- Test: `packages/web/src/routes/talk/__tests__/stage.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest"
import { deriveStage, heroOrbSize, shouldDelayStageChange, DOCKED_ORB_SIZE } from "../stage"

describe("deriveStage", () => {
  it("is hero when idle with no rows and no pinned cards", () => {
    expect(deriveStage({ state: "idle", hasRows: false, pinnedCount: 0 })).toBe("hero")
  })
  it("is hero while listening with no rows", () => {
    expect(deriveStage({ state: "listening", hasRows: false, pinnedCount: 0 })).toBe("hero")
  })
  it("is conversing on the FIRST thinking beat even with zero rows", () => {
    expect(deriveStage({ state: "thinking", hasRows: false, pinnedCount: 0 })).toBe("conversing")
  })
  it("is conversing while speaking", () => {
    expect(deriveStage({ state: "speaking", hasRows: false, pinnedCount: 0 })).toBe("conversing")
  })
  it("is conversing when rows exist even at idle", () => {
    expect(deriveStage({ state: "idle", hasRows: true, pinnedCount: 0 })).toBe("conversing")
  })
  it("is content whenever an unresolved pinned card exists (outranks everything)", () => {
    expect(deriveStage({ state: "idle", hasRows: false, pinnedCount: 1 })).toBe("content")
    expect(deriveStage({ state: "speaking", hasRows: true, pinnedCount: 2 })).toBe("content")
  })
})

describe("shouldDelayStageChange", () => {
  it("delays only downgrades to hero (anti-churn)", () => {
    expect(shouldDelayStageChange("conversing", "hero")).toBe(true)
    expect(shouldDelayStageChange("content", "hero")).toBe(true)
  })
  it("applies every other transition immediately", () => {
    expect(shouldDelayStageChange("hero", "conversing")).toBe(false)
    expect(shouldDelayStageChange("conversing", "content")).toBe(false)
    expect(shouldDelayStageChange("content", "conversing")).toBe(false)
    expect(shouldDelayStageChange("hero", "hero")).toBe(false)
  })
})

describe("orb sizing", () => {
  it("docked size is 56", () => {
    expect(DOCKED_ORB_SIZE).toBe(56)
  })
  it("hero size is half the stage's min dimension, clamped to [140, 300]", () => {
    expect(heroOrbSize(800, 600)).toBe(300)
    expect(heroOrbSize(400, 500)).toBe(200)
    expect(heroOrbSize(200, 180)).toBe(140)
  })
  it("tolerates a zero/unmeasured rect", () => {
    expect(heroOrbSize(0, 0)).toBe(140)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @cuttlefish/web test -- --run src/routes/talk/__tests__/stage.test.ts`
Expected: FAIL — module `../stage` not found.

- [ ] **Step 3: Implement `stage.ts`**

```ts
/**
 * Cuttlefish Talk — stage state machine (stage redesign).
 *
 * One derived mode decides who owns the centre of the screen:
 *   hero       — nothing to show; the orb is the hero (idle/listening, empty).
 *   conversing — words exist (or are imminent); the transcript owns the stage
 *                and the orb docks small at the top. Includes the FIRST
 *                thinking beat (state alone, zero rows) so the orb yields
 *                immediately, not only after text lands.
 *   content    — an unresolved blocking card (approval/choice) exists; the
 *                card is the single focal point, the transcript dims.
 *
 * Pure + total: unknown inputs fall through to "conversing" (transcript
 * visible is the safest default).
 */
import { useEffect, useRef, useState } from "react"

export type StageMode = "hero" | "conversing" | "content"

export interface StageInput {
  state: "idle" | "listening" | "thinking" | "speaking"
  hasRows: boolean
  pinnedCount: number
}

export function deriveStage(input: StageInput): StageMode {
  if (input.pinnedCount > 0) return "content"
  if (input.hasRows || input.state === "thinking" || input.state === "speaking") return "conversing"
  if (input.state === "idle" || input.state === "listening") return "hero"
  return "conversing"
}

/** Only a downgrade to hero is debounced — sub-second state flickers must not
 *  bounce the orb back to hero size mid-conversation. Everything else is
 *  immediate (content always wins instantly). */
export function shouldDelayStageChange(prev: StageMode, next: StageMode): boolean {
  return next === "hero" && prev !== "hero"
}

export const STAGE_DOWNGRADE_HOLD_MS = 600

export const DOCKED_ORB_SIZE = 56

/** Hero orb size from the stage cell rect: half the min dimension, clamped. */
export function heroOrbSize(width: number, height: number): number {
  const base = Math.min(width || 0, height || width || 0)
  return Math.max(140, Math.min(base * 0.5, 300))
}

/** React binding: derives the mode and applies the downgrade hold. */
export function useStageMode(input: StageInput): StageMode {
  const target = deriveStage(input)
  const [mode, setMode] = useState<StageMode>(target)
  const timerRef = useRef<number | null>(null)
  useEffect(() => {
    if (target === mode) return
    if (!shouldDelayStageChange(mode, target)) {
      setMode(target)
      return
    }
    timerRef.current = window.setTimeout(() => setMode(target), STAGE_DOWNGRADE_HOLD_MS)
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [target, mode])
  return mode
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @cuttlefish/web test -- --run src/routes/talk/__tests__/stage.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/talk/stage.ts packages/web/src/routes/talk/__tests__/stage.test.ts
git commit -m "feat(talk): stage state machine (hero/conversing/content + downgrade hold)"
```

---

### Task 3: Grid restructure — every region becomes a flow row

**Files:**
- Modify: `packages/web/src/routes/talk/page.tsx` (the `return` block, lines ~111-361)
- Modify: `packages/web/src/routes/talk/conversation-stream.css` (`.cstream` block + delete `.cstream--input-open`)
- Modify: `packages/web/src/routes/talk/conversation-stream.tsx` (only if it references the removed modifier; the `className` prop stays — page stops passing the modifier)
- Modify: `packages/web/src/routes/talk/attach-banner.tsx` (outer wrapper)
- Modify: `packages/web/src/routes/talk/work-dock.css` (`.wd-wrap` block)

The orb stays `CenteredOrb` (absolute overlay) in this task — it is replaced in Task 4. The page must render correctly at every commit.

- [ ] **Step 1: Restructure the `page.tsx` return block.** Compute the stage mode after the existing `pinnedCards` memo (around line 45):

```tsx
import { useStageMode } from "./stage"
// …inside TalkPage, after the pinnedCards memo:
const stage = useStageMode({
  state: talk.state,
  hasRows: talk.rows.length > 0,
  pinnedCount: pinnedCards.length,
})
```

Replace the root div + region wrappers (keep ALL inner content — buttons, pickers, hints, forms — byte-identical unless listed):

```tsx
return (
  <div
    data-state={talk.state}
    data-stage={stage}
    className="talk-root relative select-none"
    style={{
      background:
        "radial-gradient(125% 125% at 50% 34%, var(--bg-tertiary) 0%, var(--bg) 60%, var(--bg) 100%)",
      color: "var(--text-primary)",
    }}
  >
    {/* row 1: top bar — same children as before, wrapper de-absolutized */}
    <div className="talk-topbar">
      {/* …existing Link / title / search / engine / mute / theme buttons unchanged… */}
    </div>

    {/* row 2: engage-attachment banners (flow; row collapses when empty) */}
    <div className="talk-banner-row">
      {showAttachBanner && (
        <AttachBanner graph={talk.graph} orchestratorId={talk.orchestratorId} />
      )}
    </div>

    {/* row 3: orb dock — reserves the docked orb's space; anchor + whisper.
        The orb itself is still the absolute CenteredOrb until Task 4. */}
    <div className="talk-orbdock" data-active={stage !== "hero"}>
      <div className="talk-orbdock__anchor" aria-hidden />
      {stage !== "hero" && talk.state === "thinking" && talk.whisper && (
        <p className="talk-whisper text-caption1 text-[var(--text-quaternary)]">{talk.whisper}</p>
      )}
    </div>

    {/* row 4: main — transcript stage + WorkDock rail */}
    <div className="talk-main">
      <div className="talk-stage">
        <ConversationStream
          rows={talk.rows}
          state={talk.state}
          onOpenThread={setChatSessionId}
          inlineCards={inlineCards}
          cardAnchorFor={talk.cardAnchorFor}
          onCardAction={talk.cardAction}
        />
      </div>
      <div className="talk-rail">
        <WorkDock
          graph={talk.graph}
          sideState={talk.sideState}
          targetThreadId={talk.targetThreadId}
          onOpenThread={setChatSessionId}
          onSelectTarget={talk.selectThread}
          onRename={talk.renameThread}
          onDismiss={talk.dismissThread}
          idle={talk.state === "idle"}
        />
      </div>
    </div>

    {/* row 5: pinned blocking cards (flow; collapses when empty) */}
    {pinnedCards.length > 0 && (
      <div className="talk-pinned">
        <ErrorBoundary
          label="talk-cards"
          resetKey={pinnedCards.map((c) => c.id).join(",")}
          fallback={
            <div className="pointer-events-none rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--material-regular)] px-4 py-2 text-caption1 text-[var(--text-tertiary)] backdrop-blur-md">
              A card couldn’t be displayed.
            </div>
          }
        >
          <PinnedCards cards={pinnedCards} onAction={talk.cardAction} />
        </ErrorBoundary>
      </div>
    )}

    {/* row 6: bottom controls — same children, wrapper de-absolutized */}
    <div className="talk-controls">
      {/* …existing Stop button / engineNotice / hint+voice indicator / typing
          form / main button / keyboard toggle unchanged… */}
    </div>

    {/* CenteredOrb stays as today (absolute overlay) until Task 4 */}
    <CenteredOrb
      state={talk.state}
      level={talk.level}
      channelHue={talk.focusHue}
      whisper={talk.whisper}
      conversing={talk.rows.length > 0 || talk.state !== "idle"}
    />

    {/* overlays unchanged: SessionPeek / SessionSearchSheet / WhisperDownloadModal */}
  </div>
)
```

Notes:
- Delete the old wrapper classNames: `absolute inset-x-0 top-0 z-30` (top bar), the pinned strip's `absolute … bottom: calc(…)` style block, the controls' `absolute inset-x-0 bottom-0 z-30` + `paddingBottom` style (padding now comes from `.talk-controls`).
- The top bar keeps its inner `px-4`-less layout — horizontal padding now comes from `.talk-topbar`; remove the wrapper's `px-4` and `style={{paddingTop}}`.
- `ConversationStream` no longer receives `className={typing ? "cstream--input-open" : undefined}` — the grid reflows when the typing form expands the controls row.
- CenteredOrb's whisper prop stays for now (Task 4 removes it); the dock-row whisper will briefly render alongside the orb's own whisper only in `thinking` — acceptable for one task, or pass `whisper={null}` to CenteredOrb in this task to avoid the double render. Pass `whisper={null}`.

- [ ] **Step 2: De-absolutize `.cstream`** in `conversation-stream.css` — replace the `.cstream` block and DELETE the `.cstream--input-open` block:

```css
.cstream {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  pointer-events: none;
  transition: opacity 480ms var(--ease-smooth, cubic-bezier(0.4, 0, 0.2, 1));
}
```

(absolute *within* `.talk-stage`, which is `position: relative` — the stream fills the stage cell exactly; the grid handles all reservation. `z-index: 20` is gone.)
Also narrow the measure: in `.cstream__scroll` change `max-width: 720px` → `max-width: 640px`.

- [ ] **Step 3: De-absolutize the attach banner** — in `attach-banner.tsx` replace the outer wrapper:

```tsx
return (
  <div className="flex w-full flex-col items-center gap-1">
    {engaged.map((node) => (
      <AttachBannerRow key={node.id} node={node} orchestratorId={orchestratorId} />
    ))}
  </div>
)
```

(no more `absolute inset-x-0 top-0 z-20` + safe-area `pt-[calc(…)]`; `.talk-banner-row` supplies padding. Inner rows unchanged — drop only the now-pointless `pointer-events-auto` if the wrapper no longer sets `pointer-events-none`.)

- [ ] **Step 4: De-absolutize the WorkDock wrapper** — in `work-dock.css` replace `.wd-wrap`:

```css
.wd-wrap {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  max-height: 100%;
}
```

(position/inset/z-index/padding-right deleted — `.talk-rail` owns placement; the narrow-screen overlay comes from `talk-layout.css`.)

- [ ] **Step 5: Typecheck + full web tests + build**

Run: `pnpm --filter @cuttlefish/web exec tsc --noEmit && pnpm --filter @cuttlefish/web test -- --run && pnpm --filter @cuttlefish/web build`
Expected: all green. (`use-conversation` and other suites are pure-logic and unaffected.)

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/routes/talk/page.tsx packages/web/src/routes/talk/conversation-stream.css packages/web/src/routes/talk/attach-banner.tsx packages/web/src/routes/talk/work-dock.css
git commit -m "feat(talk): grid stage layout — all regions become flow rows"
```

---

### Task 4: OrbLayer — one persistent orb morphing hero ↔ docked

**Files:**
- Create: `packages/web/src/routes/talk/orb-layer.tsx`
- Modify: `packages/web/src/routes/talk/motion.ts` (add `stage` spring preset)
- Modify: `packages/web/src/routes/talk/page.tsx` (anchor refs; replace `CenteredOrb`)
- Modify: `packages/web/src/routes/talk/aura-avatar.tsx` (optional `docked` prop → class)
- Modify: `packages/web/src/routes/talk/aura-avatar.css` (docked glow clamp; delete `.talk-orb-shell*` blocks)
- Test: `packages/web/src/routes/talk/__tests__/stage.test.ts` (already covers sizing; no DOM test — measurement code is browser-geometry-bound, verified in E2E)

- [ ] **Step 1: Add the `stage` spring preset to `SPRING_PRESETS` in `motion.ts`:**

```ts
  /** Overdamped hero↔dock morph — decisive, no bounce (the "one mover"). */
  stage: { stiffness: 170, damping: 26, mass: 1 },
```

- [ ] **Step 2: Create `orb-layer.tsx`:**

```tsx
/**
 * Cuttlefish Talk — OrbLayer (stage redesign).
 *
 * ONE persistent orb that morphs between two measured anchors instead of
 * unmount/remount: the stage cell centre (hero) and the 56px dock anchor in the
 * orb-dock row (docked). x/y/size each chase their target with an overdamped
 * spring (motion.ts), so the morph is interruptible and honours
 * prefers-reduced-motion (useSpringValue snaps). Layout correctness never
 * depends on the animation: a missing anchor simply keeps the last target.
 *
 * While the dock row's height transition runs (mode change), anchors move
 * without resizing — ResizeObserver alone would miss it — so a short rAF
 * re-measure window chases the settling layout.
 */
import { useLayoutEffect, useState, type ComponentProps, type RefObject } from "react"
import { AuraAvatar } from "./aura-avatar"
import { SPRING_PRESETS, useSpringValue } from "./motion"
import { DOCKED_ORB_SIZE, heroOrbSize, type StageMode } from "./stage"

const SETTLE_WINDOW_MS = 700

interface OrbLayerProps {
  mode: StageMode
  state: ComponentProps<typeof AuraAvatar>["state"]
  level: number | undefined
  channelHue: number | undefined
  heroAnchorRef: RefObject<HTMLDivElement | null>
  dockAnchorRef: RefObject<HTMLDivElement | null>
}

interface OrbTarget {
  x: number
  y: number
  size: number
}

export function OrbLayer({ mode, state, level, channelHue, heroAnchorRef, dockAnchorRef }: OrbLayerProps) {
  const docked = mode !== "hero"
  const [target, setTarget] = useState<OrbTarget | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const el = (docked ? dockAnchorRef : heroAnchorRef).current
      if (!el) return
      const r = el.getBoundingClientRect()
      const size = docked ? DOCKED_ORB_SIZE : heroOrbSize(r.width, r.height)
      setTarget({ x: r.left + r.width / 2, y: r.top + r.height / 2, size })
    }
    measure()
    // Chase the dock row's height transition (anchors translate w/o resizing).
    let raf = 0
    const started = performance.now()
    const chase = () => {
      measure()
      if (performance.now() - started < SETTLE_WINDOW_MS) raf = requestAnimationFrame(chase)
    }
    raf = requestAnimationFrame(chase)
    const ro = new ResizeObserver(measure)
    if (heroAnchorRef.current) ro.observe(heroAnchorRef.current)
    if (dockAnchorRef.current) ro.observe(dockAnchorRef.current)
    window.addEventListener("resize", measure)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [docked, heroAnchorRef, dockAnchorRef])

  const x = useSpringValue(target?.x ?? 0, SPRING_PRESETS.stage)
  const y = useSpringValue(target?.y ?? 0, SPRING_PRESETS.stage)
  const size = useSpringValue(target?.size ?? DOCKED_ORB_SIZE, SPRING_PRESETS.stage)

  if (!target) return null
  return (
    <div
      className="talk-orb-layer"
      style={{
        transform: `translate3d(${x - size / 2}px, ${y - size / 2}px, 0)`,
        width: Math.round(size),
        height: Math.round(size),
      }}
    >
      <AuraAvatar
        state={state}
        level={level}
        size={Math.round(size)}
        channelHue={channelHue}
        docked={docked}
      />
    </div>
  )
}
```

(If the first `useSpringValue` render starting at 0 causes a visible fly-in from the corner on mount, gate it: keep returning `null` until the first measure, as written — springs then initialize AT the measured target because `useSpringValue`'s initial state is its first `target` argument. Verify this is true in `motion.ts` — it is: `useState(target)`.)

- [ ] **Step 3: Wire it in `page.tsx`** — add refs, attach them, replace `CenteredOrb`:

```tsx
import { OrbLayer } from "./orb-layer"
// inside TalkPage:
const heroAnchorRef = useRef<HTMLDivElement | null>(null)
const dockAnchorRef = useRef<HTMLDivElement | null>(null)
```

- `.talk-orbdock__anchor` div gets `ref={dockAnchorRef}`.
- `.talk-stage` div gets `ref={heroAnchorRef}`.
- DELETE the entire `CenteredOrb` function component (lines ~365-427) and its usage; render instead (same position in the tree, after the controls row):

```tsx
<OrbLayer
  mode={stage}
  state={talk.state}
  level={talk.level}
  channelHue={talk.focusHue}
  heroAnchorRef={heroAnchorRef}
  dockAnchorRef={dockAnchorRef}
/>
```

- Remove now-unused imports (`useLayoutEffect` if unused, `AuraAvatar` from page.tsx).

- [ ] **Step 4: `docked` prop on AuraAvatar + glow clamp.** In `aura-avatar.tsx` add an optional prop `docked?: boolean` (default false) and append the class `aura--docked` to the root `.aura` element when set. In `aura-avatar.css`:

```css
/* Docked: the orb is a status light — clamp the halo so it cannot bleed into
   neighbouring text (the hero glow extends -26%; docked stays inside the row). */
.aura--docked .aura__glow {
  inset: -6px;
  filter: blur(8px);
}
```

And DELETE the `.talk-orb-shell`, `.talk-orb-shell--conversing` blocks and their reduced-motion override (the whisper keyframes/`.talk-whisper` styles stay — the dock row reuses them).

- [ ] **Step 5: Typecheck + tests + build**

Run: `pnpm --filter @cuttlefish/web exec tsc --noEmit && pnpm --filter @cuttlefish/web test -- --run && pnpm --filter @cuttlefish/web build`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/routes/talk/orb-layer.tsx packages/web/src/routes/talk/motion.ts packages/web/src/routes/talk/page.tsx packages/web/src/routes/talk/aura-avatar.tsx packages/web/src/routes/talk/aura-avatar.css
git commit -m "feat(talk): persistent OrbLayer — spring morph between hero and dock anchors"
```

---

### Task 5: Content-stage focus treatment + idle transcript recede

**Files:**
- Modify: `packages/web/src/routes/talk/conversation-stream.css` (idle-recede tweak)
- Modify: `packages/web/src/routes/talk/talk-layout.css` (already has the content rules from Task 1 — verify they bite)

- [ ] **Step 1: Scope the idle recede.** Today `.cstream[data-state="idle"] { opacity: 0.6 }` dims the transcript at idle. With the stage system, dimming belongs to stage semantics: at `conversing`+idle the transcript IS the stage owner and should stay readable. Replace that block in `conversation-stream.css`:

```css
/* Hero stage (empty surface): nothing to recede — handled by stage rules.
   While AURA listens mid-conversation the transcript stays fully present. */
```

(i.e., DELETE the `.cstream[data-state="idle"]` rule; the `content`-mode dim lives in `talk-layout.css` keyed on `data-stage`.)

- [ ] **Step 2: Manual sanity via dev server (optional)** — `pnpm --filter @cuttlefish/web dev`, open /talk, confirm: empty surface → big centered orb; after a row exists the orb docks top; a pinned approval dims the stream and rings the card.

- [ ] **Step 3: Tests + build**

Run: `pnpm --filter @cuttlefish/web test -- --run && pnpm --filter @cuttlefish/web build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/routes/talk/conversation-stream.css packages/web/src/routes/talk/talk-layout.css
git commit -m "feat(talk): content-stage focus — card focal ring, transcript dim"
```

---

### Task 6: Cleanup + reduced-motion audit + full gates

**Files:**
- Modify: any talk CSS file still carrying dead rules (`.cstream--input-open` remnants, `.talk-orb-shell*`), `page.tsx` dead imports
- Verify: whole branch

- [ ] **Step 1: Dead-rule sweep.** `grep -rn "cstream--input-open\|talk-orb-shell\|CenteredOrb" packages/web/src` → expect zero hits; delete any stragglers.

- [ ] **Step 2: Reduced-motion audit.** Confirm each new/changed animation has a fallback: `.talk-orbdock` height transition disabled (talk-tokens/layout media block), `useSpringValue` snaps (built-in), whisper + stream rows already covered. Add any missing block to `talk-layout.css`.

- [ ] **Step 3: Hardcoded-value sweep in touched files.** In `talk-layout.css`, `talk-tokens.css`, the modified blocks of `work-dock.css`/`conversation-stream.css`: spacing uses `--space-*`, durations use `--motion-*`/named easings. (Untouched legacy rules elsewhere are out of scope.)

- [ ] **Step 4: Full gates**

Run: `pnpm --filter @cuttlefish/web exec tsc --noEmit && pnpm --filter @cuttlefish/web test -- --run && pnpm --filter @cuttlefish/web build && pnpm --filter cuttlefish-cli test -- --run`
Expected: all green (cuttlefish-cli untouched; `messages-partial.test.ts` is a known pre-existing flake — rerun isolated if it trips).

- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src/routes/talk docs/superpowers/plans/2026-06-10-talk-stage-redesign.md
git commit -m "chore(talk): stage redesign cleanup — dead rules, reduced-motion, tokens sweep"
```

---

### Task 7: Browser verification on an isolated gateway + screenshots

Not a code task — executed by the controller (Wave 4). Recipe: isolated `CUTTLEFISH_HOME` (mktemp) + fresh port (7880) + seeded mock sessions, Playwright in the isolated temp dir, scenarios: (1) idle hero orb, (2) first turn — orb docks on thinking BEFORE any text, (3) conversation karaoke with docked orb, (4) delegation chips + WorkDock rail, (5) pinned approval → content stage (dim + ring), (6) type-to-talk open (grid reflow, no overlap), (7) attach banner row, (8) light theme, (9) 390×844 mobile viewport (rail overlay, no collisions). Capture screenshots, attach to chat session, verify zero console errors.
