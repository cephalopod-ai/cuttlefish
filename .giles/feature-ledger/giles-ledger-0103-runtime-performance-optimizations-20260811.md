# Feature Ledger: runtime-performance-optimizations

**feature id:** `runtime-performance-optimizations`

## Runtime hot-path optimizations (2026-08-11)

**action summary:** Implemented three scoped allocation and I/O reductions:
deferred parent callbacks now scan transcripts backward without cloning and
reversing them; Claude limit collection stats snapshots before parsing and
stops at the newest useful snapshot while reusing its parsed payload; project
grouping selects deterministic cycle roots in linear time and reuses the
already sorted session list when constructing tree nodes.

**status:** implemented; validation results recorded below.

**provenance:** direct source inspection and targeted performance review of
runtime callback, engine-limit, and dashboard project-grouping paths. Giles and
Dory executables were not available, so this is a manual evidence entry and
does not declare compliance.

**touched files:**
- `packages/cuttlefish/src/sessions/callbacks.ts`
- `packages/cuttlefish/src/sessions/__tests__/callbacks.test.ts`
- `packages/cuttlefish/src/shared/engine-limits.ts`
- `packages/web/src/components/chat/project-session-tree.ts`
- `.giles/feature-ledger/giles-ledger-0103-runtime-performance-optimizations-20260811.md`

**validation run:** `pnpm --filter @cuttlefish/contracts build` passed;
targeted callback tests passed (38/38); targeted project-tree tests passed
(4/4); `pnpm typecheck` passed; `pnpm lint` passed; `pnpm test` passed 313
cuttlefish-cli files and 2,620 tests with 2 skipped, but retained the known,
unrelated port-occupancy failure in `lifecycle-stop.test.ts:159` because
`status.error` was undefined; Turbo therefore did not run the web package in
that full-suite command. The targeted web project-tree suite passed separately.

**remaining open items:** None in the scoped implementation. No live daemon,
connector, engine CLI, or browser playtest is required because the changes do
not alter a perceptible web surface or external behavior.
