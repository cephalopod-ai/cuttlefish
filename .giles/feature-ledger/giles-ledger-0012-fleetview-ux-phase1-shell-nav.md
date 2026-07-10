# Giles Feature Ledger — Entry 0012

## Feature ID
`fleetview-ux-phase1-shell-nav-2026-07-10`

## Short Action Summary
Implemented Phase 1 ("Shell and navigation") of the FleetView UX/UI implementation
plan (`docs/plans/2026-07-10-fleetview-ux-implementation-plan.md`, ledger entries
0010–0011), scoped strictly to `packages/web` (presentation layer only). Follows on
from Phase 0 (ledger 0011), whose PR (#25) has since merged — this work branches
fresh from `main` per the repo's merged-branch restart convention.

Concretely:

- **Grouped navigation.** `lib/nav.ts` gained a `group: "work" | "organization" |
  "ops"` field per the plan's Section 4.2 grouping, and two previously
  URL-only/hidden surfaces — **Command Center** (`/command`) and **Orchestration**
  (`/orchestration`) — are now regular `NAV_ITEMS` entries (group `ops`), closing the
  "hidden power surfaces" gap the plan's audit flagged. `NavList` (the nav popover
  used on every non-chat route) renders a group header before each contiguous run of
  same-group items. The icon-only, drag-reorderable desktop rail (`NavRibbon`) was
  deliberately left visually flat — see Remaining Open Items.
- **Mobile tab swap.** The curated 5-item mobile tab bar swaps Cron for Approvals
  ("attention beats configuration on a small screen," per the plan) —
  `MOBILE_TAB_HREFS` and its test updated together.
- **Command palette completeness.** `global-search.tsx`'s `STATIC_PAGES` list now
  sources every entry from `lib/vocabulary.ts` and covers all 13 nav destinations —
  previously Approvals, Archive, Talk, Limits, and Orchestration were absent, and the
  "Command Center" entry's icon field was accidentally bound to the cmdk `<Command>`
  wrapper component instead of a lucide icon (a real, if minor, pre-existing bug;
  fixed as part of the same edit since it directly undermined the AC this phase
  targets).
- **Keyboard model.** Added `useGoToNavigation` (`hooks/use-go-to-navigation.ts`): a
  `g`-then-key leader sequence that jumps to any of 13 surfaces from anywhere in the
  app (guarded against editable fields, open dialogs, and modifier keys). Added
  `GlobalShortcuts` (`components/global-shortcuts.tsx`), mounted once in
  `PageLayout`, binding `?` to a documentation sheet listing every go-to target plus
  ⌘K. Relocated the existing, already-generic `ShortcutOverlay` component from
  `components/chat/` to `components/ui/` (and its test alongside it) since it now
  backs both the chat route's page-local shortcut sheet and this new global one —
  no behavior change, just a more accurate home for a component that was already
  chat-agnostic.
- **`packages/web/docs/components.md`** extended with sections documenting the nav
  group model and the new keyboard-shortcut components.

## Touched Files
- `packages/web/src/lib/nav.ts` — `NavGroup`, `NAV_GROUP_LABELS`, grouped/reordered
  `NAV_ITEMS` (+ Command Center, + Orchestration), `MOBILE_TAB_HREFS` swap.
- `packages/web/src/lib/__tests__/nav.test.ts` — new-item/group assertions; updated
  mobile-tab expectation.
- `packages/web/src/components/chat/__tests__/mobile-tab-bar.test.tsx` — updated
  Cron → Approvals expectations.
- `packages/web/src/components/pill-nav.tsx` — `NavList` group headers;
  `PillNav`'s `/command` icon fallback removed (now resolves through the normal
  `NAV_ITEMS` lookup like every other route).
- `packages/web/src/components/global-search.tsx` — `STATIC_PAGES` sourced from
  `VOCABULARY`, completed to all 13 destinations, fixed the Command Center icon bug.
- `packages/web/src/hooks/use-go-to-navigation.ts` (new)
- `packages/web/src/hooks/__tests__/use-go-to-navigation.test.tsx` (new)
- `packages/web/src/components/global-shortcuts.tsx` (new)
- `packages/web/src/components/__tests__/global-shortcuts.test.tsx` (new)
- `packages/web/src/components/ui/shortcut-overlay.tsx` (moved from
  `components/chat/shortcut-overlay.tsx`, no behavior change)
- `packages/web/src/components/ui/__tests__/shortcut-overlay.test.tsx` (moved from
  `components/chat/__tests__/shortcut-overlay.test.tsx`)
- `packages/web/src/routes/chat/chat-page-shell.tsx` — import path updated for the move.
- `packages/web/src/routes/chat/chat-page-shell.test.tsx` — mock path updated for the move.
- `packages/web/src/components/page-layout.tsx` — mounts `GlobalShortcuts` on
  non-chromeless routes.
- `packages/web/docs/components.md` — nav-group and keyboard-shortcut sections.
- `.giles/feature-ledger/giles-ledger-0012-fleetview-ux-phase1-shell-nav.md` (this entry).

## Validation Run
All run from `packages/web` against a fresh `pnpm install` + `pnpm --filter=@cuttlefish/contracts build`:
- `pnpm exec tsc --noEmit -p tsconfig.json` — clean, zero errors.
- `pnpm exec vitest run` (full package suite) — **101 test files / 850 tests, all
  passing**, including new coverage for `useGoToNavigation` (arming/disarming,
  every `GO_TO_TARGETS` entry, editable-field guard, open-dialog guard, modifier
  guard, unmount cleanup) and `GlobalShortcuts` (opens on `?`, documents every
  target, toggles, closes on Escape), plus updated `nav.test.ts` and
  `mobile-tab-bar.test.tsx` assertions for the new grouping/swap.
- `pnpm --filter=@cuttlefish/web lint` (`eslint --max-warnings=0`) — clean.
- `pnpm build` (Vite production build) — succeeds.
- Not run: a live browser/Playwright walkthrough of the grouped nav popover, the new
  rail entries, or the keyboard flows — this environment has no display. The
  CI-equivalent gates above are the verification for this pass; flagging explicitly
  per the repo's "don't claim UI verification you couldn't perform" convention. In
  particular the visual appearance of the new `NavList` group headers and the
  `ShortcutOverlay` sheet's layout with 15 rows were reasoned through from the
  existing CSS-token conventions, not screenshotted.

## Remaining Open Items
Phase 1's stated AC is "every route reachable from nav or a breadcrumbed parent;
palette navigates to all surfaces; keyboard map documented" — the palette and
keyboard-map pieces are met; nav reachability is substantially improved (Command
Center and Orchestration promoted) but not fully closed:
- `/file` remains reachable only by URL — the plan calls for demoting it to a
  contextual viewer (breadcrumbed from a session/artifact), which touches every call
  site that currently deep-links to it. Deferred; larger scope than this pass budgeted.
- The desktop icon rail (`NavRibbon`) does not render visual group dividers — only
  the text-list popover (`NavList`) does. The rail is a dense, drag-reorderable
  icon strip with no visible text at rest; inserting dividers there is a real visual
  redesign this pass chose not to attempt without the ability to screenshot/verify it.
  Default item order is still grouped contiguously (Work → Organization → Ops), so
  the grouping exists structurally even without a rendered divider on the rail.
- A per-user `localStorage` nav-order setting that already pins specific hrefs will
  simply not include Command Center/Orchestration in a custom order until the user
  re-touches settings — `applyNavOrder`'s "append unknown items at the end" behavior
  (unchanged from Phase 0) means they still appear, just at the tail, which is
  correct/expected per that function's documented contract.
- The global `g`-then-key layer is intentionally absent from the chat route (chat
  keeps its own distinct, richer local shortcut set, including its own `?`). Unifying
  the two — e.g., giving chat access to global go-to navigation too — is a
  reasonable follow-up but was judged higher-risk (touching chat's already-dense,
  heavily-tested keyboard handling) than this pass's budget justified.
- Full three-layer design-token formalization, the contrast-lint script, and the
  Queue/Table `DataView` system (Phase 3) remain untouched, as do Phase 2's
  five-state-contract sweep across the *rest* of the surfaces (Phase 0 covered only
  Approvals and Cron) and Phase 4/5's org-chart/kanban/Command-Center deepening.

## Provenance
Authored directly in this session (remote cloud agent) against the live
`packages/web` source tree, branched fresh from `main` after PR #25 (the plan +
Phase 0) merged. Not reconstructed from archives or prior session logs.
