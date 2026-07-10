# Giles Feature Ledger — Entry 0016

## Feature ID
`fleetview-ux-phase5-command-center-2026-07-10`

## Short Action Summary
Implemented Phase 5 ("Command Center as attention hub") of the FleetView UX/UI
implementation plan (`docs/plans/2026-07-10-fleetview-ux-implementation-plan.md`,
ledger entries 0010–0015), scoped strictly to `packages/web`. Branched fresh from
`main` (Phases 0–4 merged). Delivered all four plan line items for this phase:

- **Triage strip with deep links.** A new `useTriageSummary()` hook composes four
  data sources into one attention count: pending approvals (existing
  `useApprovals('pending')`), blocked tickets (existing
  `useCommandCenter().data.ticketCounts.blocked`), broken/invalid cron schedules
  (existing `useCronJobs()` filtered on `scheduleValid === false`, extracted as a
  pure helper `countBrokenCronJobs`), and at-risk engine rate limits (a new
  `useEngineLimits()` query hook + pure helper `countAtRiskEngines`, flagging any
  usage window at or above an 80% threshold). Command Center renders one
  `TriageChip` per source, each deep-linking to its filtered surface
  (`/approvals`, `/kanban`, `/cron`, `/limits`); a zero count renders calm/neutral,
  a nonzero count renders amber attention styling.
- **KPI tiles on a shared `KpiTile` primitive.** Extracted the Command Center's
  inline `MetricCard` into `components/ui/kpi-tile.tsx` (identical visual output),
  the shared component named in the plan's Section 8 component list.
- **Attention-aware landing preference.** New `attentionAwareLanding` setting
  (default off) plus a `LandingRoute` wrapper mounted at `/` in `main.tsx`: when on
  and `useTriageSummary().total > 0`, it redirects to `/command` instead of
  rendering Chat. A bare `/` with no query string is treated as "just opened the
  app"; any URL carrying a query string (e.g. `/?employee=boss`, used by Command
  Center's "Start chat with X" links) always renders Chat — a deep link is an
  explicit destination, not a landing to be reinterpreted. Reuses
  `useTriageSummary()` so the triage strip and the landing redirect can never
  disagree about what needs attention.
- **Notification preference matrix in Settings.** New `notificationPreferences`
  setting: a 4-event-class (`approvals`, `ticketsBlocked`, `cronFailures`,
  `limitsAtRisk`) × 2-channel (`badge`, `toast`) boolean matrix, rendered as a new
  "Notifications" settings section alongside the attention-aware-landing toggle.
  Only the "approvals badge" toggle is wired to a live effect — `pill-nav.tsx`'s
  existing nav-rail approvals badge now reads
  `settings.notificationPreferences.approvals.badge` and hides the count when off.
  The other 7 cells (three other event classes' badges, and all four toast
  columns) persist to `localStorage` but have no emitting event to gate yet — see
  Remaining Open Items.

## Touched Files
- `packages/web/src/lib/query-keys.ts` — added `engineLimits.all` query key.
- `packages/web/src/hooks/use-engine-limits.ts` (new) — `useEngineLimits()` query
  hook, 60s poll.
- `packages/web/src/lib/triage.ts` (new) — `countAtRiskEngines`,
  `countBrokenCronJobs` pure helpers.
- `packages/web/src/lib/triage.test.ts` (new) — 8 tests.
- `packages/web/src/hooks/use-triage-summary.ts` (new) — composing hook.
- `packages/web/src/hooks/__tests__/use-triage-summary.test.ts` (new) — 3 tests.
- `packages/web/src/components/ui/kpi-tile.tsx` (new) — extracted `MetricCard`.
- `packages/web/src/components/ui/__tests__/kpi-tile.test.tsx` (new) — 2 tests.
- `packages/web/src/components/ui/triage-chip.tsx` (new).
- `packages/web/src/components/ui/__tests__/triage-chip.test.tsx` (new) — 3 tests.
- `packages/web/src/routes/command/page.tsx` — replaced local `MetricCard` with
  `KpiTile`; added the triage strip using `TriageChip` + `useTriageSummary()`.
- `packages/web/src/routes/command/page.test.tsx` — mutable `triageState` mock
  (mirrors the file's existing `commandCenterState` pattern); new test asserting
  triage-strip chip labels/hrefs render with nonzero counts from every source.
- `packages/web/src/lib/settings.ts` — added `attentionAwareLanding: boolean` and
  `notificationPreferences: NotificationPreferences` fields + defaults; new
  exported types `NotificationEventClass`, `NotificationChannel`,
  `NotificationPreferences`, `DEFAULT_NOTIFICATION_PREFERENCES`.
- `packages/web/src/routes/settings-provider.tsx` — `setAttentionAwareLanding`,
  `setNotificationPreference` setters; `resetAll` covers both new fields.
- `packages/web/src/routes/landing-route.tsx` (new) — the `/` gate component.
- `packages/web/src/routes/__tests__/landing-route.test.tsx` (new) — 5 tests
  (off, on-but-clear, on-and-redirects, query-string-always-chat,
  loading-never-redirects).
- `packages/web/src/main.tsx` — `/` route now renders `LandingRoute` instead of
  `ChatPage` directly.
- `packages/web/src/routes/settings/settings-page-sections.tsx` — new
  `NotificationsSection` component (landing toggle + event×channel matrix).
- `packages/web/src/routes/settings/page.tsx` — wires `NotificationsSection` in.
- `packages/web/src/components/pill-nav.tsx` — approvals badge count gated on
  `notificationPreferences.approvals.badge`.
- `packages/web/src/components/__tests__/nav-ribbon.test.tsx` — new test: badge
  hidden when the approvals-badge preference is off.
- `.giles/feature-ledger/giles-ledger-0016-fleetview-ux-phase5-command-center.md`
  (this entry).

## Validation Run
All run from `packages/web` against a fresh `pnpm install` +
`pnpm --filter=@cuttlefish/contracts build`:
- `pnpm exec tsc --noEmit -p tsconfig.json` — clean, zero errors.
- `pnpm exec vitest run` (full package suite) — **112 test files / 915 tests, all
  passing**, including all new tests listed above. All pre-existing tests pass
  unchanged.
- `pnpm --filter=@cuttlefish/web lint` (`eslint --max-warnings=0`) — clean.
- `pnpm build` (Vite production build) — succeeds.
- **Not tested**: no live browser walkthrough was performed (this environment has
  no display) — flagging per the repo's "don't claim UI verification you couldn't
  perform" convention. Coverage is type-checking, unit tests, and component-level
  render tests with mocked data sources; the actual React-Query network wiring for
  `useEngineLimits()` was verified by type/shape only, matching the existing
  `EngineLimitsResponse` contract type, not against a live gateway.

## Remaining Open Items
- **Notification matrix: only 1 of 8 cells is wired to a live effect.** The
  approvals badge toggle gates the existing nav-rail badge. The other three
  badge cells (blocked tickets, cron failures, limits at risk) have no
  corresponding badge UI anywhere yet — building those means adding new badge
  affordances to `/kanban`, `/cron`, `/limits` nav items first, which is outside
  this phase's named deliverable ("notification preference matrix," not "badges on
  every nav item"). All four toast-channel cells persist a preference but no
  toast-triggering infrastructure exists in this codebase at all (no toast
  primitive, no event bus for these four event classes) — wiring that up is a
  cross-cutting addition better scoped as its own feature, not folded silently
  into a Settings-page change. Both gaps are called out directly in the
  Notifications section's own `FieldHint` copy so the UI doesn't imply more than
  it delivers.
- **At-risk threshold (80%) is a fixed constant** (`AT_RISK_THRESHOLD_PERCENT` in
  `lib/triage.ts`), not user-configurable. The plan didn't specify a
  configurability requirement for this phase; deferred as out of scope.

## Provenance
Authored directly in this session (remote cloud agent) against the live
`packages/web` source tree, branched fresh from `main` (Phases 0–4 merged). Not
reconstructed from archives or prior session logs.
